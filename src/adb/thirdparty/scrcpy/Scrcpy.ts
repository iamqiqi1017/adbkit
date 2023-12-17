/*
 * @Author: mingLiang
 * @Date: 2023-12-16 23:12:15
 * @LastEditTime: 2023-12-17 01:04:24
 * @FilePath: \adbkit\src\adb\thirdparty\scrcpy\Scrcpy.ts
 */
import EventEmitter from 'events';
import PromiseDuplex from 'promise-duplex';
import DeviceClient from '../../DeviceClient';
import Utils from '../../utils';
import { Duplex } from 'stream';
import { MotionEvent, Orientation, ControlMessage } from './ScrcpyConst';
import { KeyCodes } from '../../keycode';
import { BufWrite } from '../minicap/BufWrite';
import ThirdUtils from '../ThirdUtils';
import fs from 'fs';
import Stats from '../../sync/stats';
import { parse_sequence_parameter_set } from './sps';
import { Point, ScrcpyOptions, H264Configuration, VideoStreamFramePacket } from './ScrcpyModels';
import assert from 'assert';
import net from 'net';

const debug = Utils.debug('adb:scrcpy');

// const KEYFRAME_PTS = BigInt(1) << BigInt(62);
// from https://github.com/Genymobile/scrcpy/blob/master/server/src/main/java/com/genymobile/scrcpy/ScreenEncoder.java

const PACKET_FLAG_CONFIG = BigInt(1) << BigInt(63);
const PACKET_FLAG_KEY_FRAME = BigInt(1) << BigInt(62);

/**
 * by hand start:
 *
 * adb push scrcpy-server-v1.8.jar /data/local/tmp/scrcpy-server.jar
 * adb push scrcpy-server-v1.20.jar /data/local/tmp/scrcpy-server.jar
 *
 * CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 600 1000 true 9999:9999:0:0 true
 *
 * adb forward tcp:8099 localabstract:scrcpy
 */

/**
 * enforce EventEmitter typing
 */
interface IEmissions {
  frame: (data: VideoStreamFramePacket) => void;
  config: (data: H264Configuration) => void;
  raw: (data: Buffer) => void;
  error: (error: Error) => void;
  disconnect: () => void;
}

/**
 * How scrcpy works?
 *
 * Its a jar file that runs on an adb shell. It records the screen in h264 and offers it in a given tcp port.
 *
 * scrcpy params
 *   maxSize         (integer, multiple of 8) 0
 *   bitRate         (integer)
 *   tunnelForward   (optional, bool) use "adb forward" instead of "adb tunnel"
 *   crop            (optional, string) "width:height:x:y"
 *   sendFrameMeta   (optional, bool)
 *
 * The video stream contains raw packets, without time information. If sendFrameMeta is enabled a meta header is added
 * before each packet.
 * The "meta" header length is 12 bytes
 * [. . . . . . . .|. . . .]. . . . . . . . . . . . . . . ...
 *  <-------------> <-----> <-----------------------------...
 *        PTS         size      raw packet (of size len)
 *
 * WARNING:
 * Need USB Debug checked in developper option for MIUI
 */
export default class Scrcpy extends EventEmitter {
  private config: ScrcpyOptions;
  private videoSocket: PromiseDuplex<Duplex> | undefined;
  private controlSocket: PromiseDuplex<Duplex> | undefined;
  /**
   * used to recive Process Error
   */
  private scrcpyServer: PromiseDuplex<Duplex> | undefined;

  ///////
  // promise holders
  private _name: Promise<string>;
  private _width: Promise<number>;
  private _height: Promise<number>;
  private _onTermination: Promise<string>;
  private _firstFrame: Promise<void>;

  ////////
  // promise resolve calls

  private setName!: (name: string) => void;
  private setWidth!: (width: number) => void;
  private setHeight!: (height: number) => void;
  private setFatalError?: (error: string) => void;
  private setFirstFrame?: (() => void) | null;

  private lastConf?: H264Configuration;
  /**
   * closed had been call stop all new activity
   */
  private closed = false;

  constructor(private client: DeviceClient, config = {} as Partial<ScrcpyOptions>) {
    super();
    this.config = {
      version: '1.24',
      // port: 8099,
      maxSize: 600,
      maxFps: 0,
      flip: false,
      bitrate: 999999999,
      lockedVideoOrientation: Orientation.LOCK_VIDEO_ORIENTATION_UNLOCKED,
      tunnelForward: true,
      tunnelDelay: 1000,
      crop: '', //'9999:9999:0:0',
      sendFrameMeta: false, // send PTS so that the client may record properly
      control: true,
      displayId: 0,
      showTouches: false,
      stayAwake: true,
      codecOptions: '',
      encoderName: '',
      powerOffScreenOnClose: false,
      // clipboardAutosync: true,
      ...config,
    };
    this._name = new Promise<string>((resolve) => (this.setName = resolve));
    this._width = new Promise<number>((resolve) => (this.setWidth = resolve));
    this._height = new Promise<number>((resolve) => (this.setHeight = resolve));
    this._onTermination = new Promise<string>((resolve) => (this.setFatalError = resolve));
    this._firstFrame = new Promise<void>((resolve) => (this.setFirstFrame = resolve));
  }

  public on = <K extends keyof IEmissions>(event: K, listener: IEmissions[K]): this => super.on(event, listener);
  public off = <K extends keyof IEmissions>(event: K, listener: IEmissions[K]): this => super.off(event, listener);
  public once = <K extends keyof IEmissions>(event: K, listener: IEmissions[K]): this => super.once(event, listener);
  public emit = <K extends keyof IEmissions>(event: K, ...args: Parameters<IEmissions[K]>): boolean =>
    super.emit(event, ...args);

  get name(): Promise<string> {
    return this._name;
  }
  get width(): Promise<number> {
    return this._width;
  }
  get height(): Promise<number> {
    return this._height;
  }

  /**
   * Clever way to detect Termination.
   * return the Ending message.
   */
  get onTermination(): Promise<string> {
    return this._onTermination;
  }

  /**
   * Promise to the first emited frame
   * can be used to unsure that scrcpy propery start
   */
  get firstFrame(): Promise<void> {
    return this._firstFrame;
  }

  /**
   * emit scrcpyServer output as Error
   * @param duplex
   * @returns
   */
  async throwsErrors(duplex: PromiseDuplex<Duplex>) {
    try {
      const errors = [];
      for (;;) {
        await Utils.waitforReadable(duplex, 0, 'wait for error');
        const data = await duplex.read();
        if (data) {
          const msg = data.toString().trim();
          errors.push(msg);
          try {
            this.emit('error', Error(msg));
          } catch (e) {
            // emit Error but to not want to Quit Yet
          }
        } else {
          this._setFatalError(errors.join('\n'));
          break;
        }
      }
    } catch (e) {
      //this.emit('error', e as Error);
      //this.setError((e as Error).message);
    }
  }

  private _setFatalError(msg: string) {
    if (this.setFatalError) {
      this.setFatalError(msg);
      this.setFatalError = undefined;
    }
  }

  /**
   * get last current video config
   */
  get videoConfig(): H264Configuration | undefined {
    return this.lastConf;
  }

  /**
   * Read a message from the contoler Duplex
   *
   * @param duplex only supoport clipboard
   * @returns
   */
  async readOneMessage(duplex: PromiseDuplex<Duplex>): Promise<string> {
    if (!duplex) return '';
    // const waitforReadable = () => new Promise<void>((resolve) => duplex.readable.stream.once('readable', resolve));
    await Utils.waitforReadable(duplex);
    let chunk = (await duplex.read(1)) as Buffer;
    const type = chunk.readUInt8();
    switch (type) {
      case 0: // clipboard
        await Utils.waitforReadable(duplex);
        chunk = (await duplex.read(4)) as Buffer;
        await Utils.waitforReadable(duplex);
        const len = chunk.readUint32BE();
        await Utils.waitforReadable(duplex);
        chunk = (await duplex.read(len)) as Buffer;
        const text = chunk.toString('utf8');
        return text;
      default:
        throw Error(`Unsupported message type:${type}`);
    }
  }

  private _getStartupLine(jarDest: string): string {
    const args: Array<string | number | boolean> = [];
    const {
      maxSize,
      bitrate,
      maxFps,
      lockedVideoOrientation,
      tunnelForward,
      // crop,
      sendFrameMeta,
      // control,
      // displayId,
      // showTouches,
      // stayAwake,
      // codecOptions,
      // encoderName,
      // powerOffScreenOnClose,
      // clipboardAutosync,
    } = this.config;
    args.push(`CLASSPATH=${jarDest}`);
    args.push('app_process');
    args.push('/');
    args.push('com.genymobile.scrcpy.Server');
    args.push(`${this.config.version}`);
    args.push('log_level=info');
    args.push(`max_size=${maxSize}`);
    // args.push('raw_stream=true');
    // args.push(`bit_rate=${bitrate}`);
    // args.push(`max_fps=${maxFps}`);
    // args.push(`lock_video_orientation=${lockedVideoOrientation}`);
    args.push(`tunnel_forward=${tunnelForward}`); // Tunnel forward
    // if (crop && crop !== '-') args.push(`crop=${crop}`); //    Crop screen
    // args.push(`send_frame_meta=${sendFrameMeta}`);
    // args.push(`control=${control}`); //  Control enabled
    // args.push(`display_id=${displayId}`); //     Display id
    // args.push(`show_touches=${showTouches}`); // Show touches
    // args.push(`stay_awake=${stayAwake}`); //  if self.stay_awake else "false",  Stay awake
    // if (codecOptions && codecOptions !== '-') args.push(`codec_options=${codecOptions}`); //     Codec (video encoding) options
    // if (encoderName && encoderName !== '-') args.push(`encoder_name=${encoderName}`); //     Encoder name
    // args.push(`power_off_on_close=${powerOffScreenOnClose}`); // Power off screen after server closed
    // // args.push(`clipboard_autosync=${clipboardAutosync}`); // default is True
    // if (clipboardAutosync !== undefined) args.push(`clipboard_autosync=${clipboardAutosync}`); // default is True
    // const { downsizeOnError, sendDeviceMeta, sendDummyByte, rawVideoStream } = this.config;
    // if (downsizeOnError !== undefined) args.push(`downsize_on_error=${downsizeOnError}`);
    // if (sendDeviceMeta !== undefined) args.push(`send_device_meta=${sendDeviceMeta}`);
    // if (sendDummyByte !== undefined) args.push(`send_dummy_byte=${sendDummyByte}`);
    // if (rawVideoStream !== undefined) args.push(`raw_video_stream=${rawVideoStream}`);
    // const { cleanup } = this.config;
    // if (cleanup !== undefined) args.push(`raw_video_stream=${cleanup}`);

    // check Server.java
    return args.map((a) => a.toString()).join(' ');
  }

  /**
   * Will connect to the android device, send & run the server and return deviceName, width and height.
   * After that data will be offered as a 'data' event.
   */
  async start(): Promise<this> {
    if (this.closed)
      // can not start once stop called
      return this;
    const jarDest = '/data/local/tmp/scrcpy-server.jar';
    // Transfer server...
    const jar = ThirdUtils.getResourcePath(`scrcpy-server-${this.config.version}.jar`);
    const srcStat: fs.Stats | null = await fs.promises.stat(jar).catch(() => null);
    const dstStat: Stats | null = await this.client.stat(jarDest).catch(() => null);
    if (!srcStat) throw Error(`fail to get ressource ${jar}`);
    if (!dstStat || srcStat.size !== dstStat.size) {
      try {
        debug(`pushing scrcpy-server.jar to ${this.client.serial}`);
        // console.log('推送jar包到手机');
        const transfer = await this.client.push(jar, jarDest);
        await transfer.waitForEnd();
      } catch (e) {
        debug(`Impossible to transfer server scrcpy-server.jar to ${this.client.serial}`, e);
        // console.log('推送jar包到手机失败');
        throw e;
      }
    } else {
      debug(`scrcpy-server.jar already present in ${this.client.serial}, keep it`);
      // console.log('jar包已经存在，跳过推送');
    }
    // Start server
    try {
      await this.client.forward('tcp:8099', 'localabstract:scrcpy');
      const cmdLine = this._getStartupLine(jarDest);
      if (this.closed)
        // can not start once stop called
        return this;
      // console.log(`启动scrcpyServer ${cmdLine}`);
      const duplex = await this.client.shell(cmdLine);
      // console.log(`scrcpyServer成功`);
      this.scrcpyServer = new PromiseDuplex(duplex);
      this.scrcpyServer.once('finish').then(() => {
        debug(`scrcpyServer finished on device ${this.client.serial}`);
        // console.log(`scrcpyServer已停止 ${this.client.serial}`);
        this.stop();
      });
      // debug only
      // extraUtils.dumpReadable(this.scrcpyServer, 'scrcpyServer');
    } catch (e) {
      debug('Impossible to run server:', e);
      // console.log('启动scrcpyServer失败');
      throw e;
    }
    let info = '';
    for (;;) {
      if (!(await Utils.waitforReadable(this.scrcpyServer, this.config.tunnelDelay, 'scrcpyServer stdout loading'))) {
        const error = `Starting scrcpyServer failed, scrcpy stdout:${info}`;
        this._setFatalError(error);
        this.stop();
        throw Error(error);
      }
      const srvOut = await this.scrcpyServer.read();
      info += srvOut ? srvOut.toString() : '';
      if (info.includes('[server] INFO: Device: ')) break;
    }
    this.throwsErrors(this.scrcpyServer);
    // console.log(info);
    if (this.closed) return this;
    await Utils.delay(1000);
    this.videoSocket = await this.client.openLocal2('localabstract:scrcpy', 'first connection to scrcpy for video');
    // Connect controlSocket
    if (this.closed) {
      this.stop();
      return this;
    }
    this.controlSocket = await this.client.openLocal2(
      'localabstract:scrcpy',
      'second connection to scrcpy for control',
    );
    if (this.closed) {
      this.stop();
      return this;
    }
    // First chunk is 69 bytes length -> 1 dummy byte, 64 bytes for deviceName, 2 bytes for width & 2 bytes for height
    try {
      await Utils.waitforReadable(this.videoSocket, 0, 'videoSocket 1st 1 bit chunk');
      const firstChunk = (await this.videoSocket.read(1)) as Buffer;
      if (!firstChunk) {
        throw Error('fail to read firstChunk, inclease tunnelDelay for this device.');
      }
      // old protocol
      const control = firstChunk.at(0);
      if (firstChunk.at(0) !== 0) {
        if (control) throw Error(`Control code should be 0x00, receves: 0x${control.toString(16).padStart(2, '0')}`);
        throw Error(`Control code should be 0x00, receves nothing.`);
      }
    } catch (e) {
      debug('Impossible to read first chunk:', e);
      throw e;
    }

    if (this.config.sendFrameMeta) {
      void this.startStreamWithMeta().catch(() => {
        console.log('报错停止');
        this.stop();
      });
    } else {
      this.startStreamRaw();
    }
    // wait the first chunk
    await this.height;
    return this;
  }

  public stop(): boolean {
    this.closed = true;
    let close = false;
    if (this.videoSocket) {
      this.videoSocket.destroy();
      this.videoSocket = undefined;
      close = true;
    }
    if (this.controlSocket) {
      this.controlSocket.destroy();
      this.controlSocket = undefined;
      close = true;
    }
    if (this.scrcpyServer) this.scrcpyServer.destroy();
    if (close) {
      this.emit('disconnect');
      this._setFatalError('stoped');
    }
    return close;
  }

  isRunning(): boolean {
    return this.videoSocket !== null;
  }

  private startStreamRaw() {
    assert(this.videoSocket);
    // console.log('startStreamRaw');
    console.log('scrcpy连接成功');
    this.videoSocket.stream.on('data', (data) => {
      // console.log('rowdata', data);
      this.emit('raw', data);
    });
  }

  /**
   * capture all video trafique in a loop
   * get resolve once capture stop
   */
  private async startStreamWithMeta(): Promise<void> {
    assert(this.videoSocket);
    // console.log('startStreamWithMeta');
    this.videoSocket.stream.pause();
    console.log('22');
    await Utils.waitforReadable(this.videoSocket, 0, 'videoSocket header');
    console.log('222');
    const chunk = this.videoSocket.stream.read(68) as Buffer;
    console.log('444');
    const name = chunk.toString('utf8', 0, 64).trim();
    this.setName(name);
    const width = chunk.readUint16BE(64);
    this.setWidth(width);
    const height = chunk.readUint16BE(66);
    this.setHeight(height);
    console.log(name, width, height);
    // let header: Uint8Array | undefined;

    let pts = BigInt(0); // Buffer.alloc(0);
    for (;;) {
      if (!this.videoSocket) break;
      await Utils.waitforReadable(this.videoSocket, 0, 'videoSocket packet size');
      let len: number | undefined = undefined;
      if (this.config.sendFrameMeta) {
        const frameMeta = this.videoSocket.stream.read(12) as Buffer;
        if (!frameMeta) {
          // regular end condition
          return;
        }
        // console.log(frameMeta.toString('hex').replace(/(........)/g, '$1 '))
        pts = frameMeta.readBigUint64BE();
        len = frameMeta.readUInt32BE(8);
        // else {bufferInfo.presentationTimeUs - ptsOrigin}
        // debug(`\tHeader:PTS =`, pts);
        // debug(`\tHeader:len =`, len);
      }

      const config = !!(pts & PACKET_FLAG_CONFIG);

      let streamChunk: Buffer | null = null;
      while (streamChunk === null) {
        await Utils.waitforReadable(this.videoSocket, 0, 'videoSocket streamChunk');
        streamChunk = this.videoSocket.stream.read(len) as Buffer;
        if (streamChunk) {
          if (config) {
            // non-media data packet len: 33
            /**
             * is a config package pts have PACKET_FLAG_CONFIG flag
             */
            const sequenceParameterSet = parse_sequence_parameter_set(streamChunk);
            const {
              profile_idc: profileIndex,
              constraint_set: constraintSet,
              level_idc: levelIndex,
              pic_width_in_mbs_minus1,
              pic_height_in_map_units_minus1,
              frame_mbs_only_flag,
              frame_crop_left_offset,
              frame_crop_right_offset,
              frame_crop_top_offset,
              frame_crop_bottom_offset,
            } = sequenceParameterSet;
            const encodedWidth = (pic_width_in_mbs_minus1 + 1) * 16;
            const encodedHeight = (pic_height_in_map_units_minus1 + 1) * (2 - frame_mbs_only_flag) * 16;
            const cropLeft = frame_crop_left_offset * 2;
            const cropRight = frame_crop_right_offset * 2;
            const cropTop = frame_crop_top_offset * 2;
            const cropBottom = frame_crop_bottom_offset * 2;
            const croppedWidth = encodedWidth - cropLeft - cropRight;
            const croppedHeight = encodedHeight - cropTop - cropBottom;

            const videoConf: H264Configuration = {
              profileIndex,
              constraintSet,
              levelIndex,
              encodedWidth,
              encodedHeight,
              cropLeft,
              cropRight,
              cropTop,
              cropBottom,
              croppedWidth,
              croppedHeight,
              data: streamChunk,
            };
            this.lastConf = videoConf;
            this.emit('config', videoConf);
          } else {
            /**
             * if pts have PACKET_FLAG_KEY_FRAME, this is a keyframe
             */
            const keyframe = !!(pts & PACKET_FLAG_KEY_FRAME);
            if (keyframe) {
              pts &= ~PACKET_FLAG_KEY_FRAME;
            }
            const frame = { keyframe, pts, data: streamChunk, config: this.lastConf };
            if (this.setFirstFrame) {
              this.setFirstFrame();
              this.setFirstFrame = undefined;
            }
            this.emit('frame', frame);
          }
        } else {
          // large chunk.
          // console.log('fail to streamChunk len:', len);
          await Utils.delay(0);
        }
      }
    }
  }

  // ControlMessages

  // TYPE_INJECT_KEYCODE
  /**
   * // will be convert in a android.view.KeyEvent
   * https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/view/KeyEvent.java
   * @param action
   * @param keyCode
   * @param repeatCount
   * @param metaState  combinaison of KeyEventMeta
   */
  async injectKeycodeEvent(
    action: MotionEvent,
    keyCode: KeyCodes,
    repeatCount: number,
    metaState: number,
  ): Promise<void> {
    const chunk = new BufWrite(14);
    chunk.writeUint8(ControlMessage.TYPE_INJECT_KEYCODE);
    chunk.writeUint8(action);
    chunk.writeUint32BE(keyCode);
    chunk.writeUint32BE(repeatCount);
    chunk.writeUint32BE(metaState);
    assert(this.controlSocket);
    await this.controlSocket.write(chunk.buffer);
  }

  // TYPE_INJECT_TEXT
  async injectText(text: string): Promise<void> {
    const chunk = new BufWrite(5);
    chunk.writeUint8(ControlMessage.TYPE_INJECT_TEXT);
    chunk.writeString(text);
    assert(this.controlSocket);
    await this.controlSocket.write(chunk.buffer);
  }

  /**
   * android.view.MotionEvent;
   * https://android.googlesource.com/platform/frameworks/base/+/master/core/java/android/view/MotionEvent.java
   * @param action
   * @param pointerId
   * @param position
   * @param screenSize
   * @param pressure
   */
  // usb.data_len == 28
  async injectTouchEvent(
    action: MotionEvent,
    pointerId: bigint,
    position: Point,
    screenSize: Point,
    pressure?: number,
  ): Promise<void> {
    const chunk = new BufWrite(28);
    chunk.writeUint8(ControlMessage.TYPE_INJECT_TOUCH_EVENT);
    chunk.writeUint8(action);
    if (pressure === undefined) {
      if (action == MotionEvent.ACTION_UP) pressure = 0x0;
      else if (action == MotionEvent.ACTION_DOWN) pressure = 0xffff;
      else pressure = 0xffff;
    }
    // Writes a long to the underlying output stream as eight bytes, high byte first.
    chunk.writeBigUint64BE(pointerId);
    chunk.writeUint32BE(position.x | 0);
    chunk.writeUint32BE(position.y | 0);
    chunk.writeUint16BE(screenSize.x | 0);
    chunk.writeUint16BE(screenSize.y | 0);
    chunk.writeUint16BE(pressure);
    chunk.writeUint32BE(MotionEvent.BUTTON_PRIMARY);
    assert(this.controlSocket);
    await this.controlSocket.write(chunk.buffer);
    // console.log(chunk.buffer.toString('hex'))
  }

  async injectScrollEvent(position: Point, screenSize: Point, HScroll: number, VScroll: number): Promise<void> {
    const chunk = new BufWrite(20);
    chunk.writeUint8(ControlMessage.TYPE_INJECT_SCROLL_EVENT);
    // Writes a long to the underlying output stream as eight bytes, high byte first.
    chunk.writeUint32BE(position.x | 0);
    chunk.writeUint32BE(position.y | 0);
    chunk.writeUint16BE(screenSize.x | 0);
    chunk.writeUint16BE(screenSize.y | 0);
    chunk.writeUint16BE(HScroll);
    chunk.writeInt32BE(VScroll);
    chunk.writeInt32BE(MotionEvent.BUTTON_PRIMARY);
    assert(this.controlSocket);
    await this.controlSocket.write(chunk.buffer);
  }

  // TYPE_BACK_OR_SCREEN_ON
  async injectBackOrScreenOn(): Promise<void> {
    const chunk = new BufWrite(2);
    chunk.writeUint8(ControlMessage.TYPE_BACK_OR_SCREEN_ON);
    chunk.writeUint8(MotionEvent.ACTION_UP);
    assert(this.controlSocket);
    await this.controlSocket.write(chunk.buffer);
  }

  // TYPE_EXPAND_NOTIFICATION_PANEL
  async expandNotificationPanel(): Promise<void> {
    const chunk = Buffer.allocUnsafe(1);
    chunk.writeUInt8(ControlMessage.TYPE_EXPAND_NOTIFICATION_PANEL);
    assert(this.controlSocket);
    await this.controlSocket.write(chunk);
  }

  // TYPE_COLLAPSE_PANELS
  async collapsePannels(): Promise<void> {
    const chunk = Buffer.allocUnsafe(1);
    chunk.writeUInt8(ControlMessage.TYPE_EXPAND_SETTINGS_PANEL);
    assert(this.controlSocket);
    await this.controlSocket.write(chunk);
  }

  // TYPE_GET_CLIPBOARD
  async getClipboard(): Promise<string> {
    const chunk = Buffer.allocUnsafe(1);
    chunk.writeUInt8(ControlMessage.TYPE_GET_CLIPBOARD);
    assert(this.controlSocket);
    await this.controlSocket.write(chunk);
    return this.readOneMessage(this.controlSocket);
  }

  // TYPE_SET_CLIPBOARD
  async setClipboard(text: string): Promise<void> {
    const chunk = new BufWrite(6);
    chunk.writeUint8(ControlMessage.TYPE_SET_CLIPBOARD);
    chunk.writeUint8(1); // past
    chunk.writeString(text);
    assert(this.controlSocket);
    await this.controlSocket.write(chunk.buffer);
  }

  // TYPE_SET_SCREEN_POWER_MODE
  async setScreenPowerMode(): Promise<void> {
    const chunk = Buffer.allocUnsafe(1);
    chunk.writeUInt8(ControlMessage.TYPE_SET_SCREEN_POWER_MODE);
    assert(this.controlSocket);
    await this.controlSocket.write(chunk);
  }

  // TYPE_ROTATE_DEVICE
  async rotateDevice(): Promise<void> {
    const chunk = Buffer.allocUnsafe(1);
    chunk.writeUInt8(ControlMessage.TYPE_ROTATE_DEVICE);
    assert(this.controlSocket);
    await this.controlSocket.write(chunk);
  }
}
