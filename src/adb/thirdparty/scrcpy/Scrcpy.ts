/* eslint-disable @typescript-eslint/ban-ts-comment */
/*
 * @Author: mingLiang
 * @Date: 2023-12-16 23:12:15
 * @LastEditTime: 2023-12-27 13:37:36
 * @FilePath: \adbkit\src\adb\thirdparty\scrcpy\Scrcpy.ts
 */
import EventEmitter from 'events';
import PromiseDuplex from 'promise-duplex';
import DeviceClient from '../../DeviceClient';
import Utils from '../../utils';
import { Duplex } from 'stream';
import { MotionEvent, ControlMessage } from './ScrcpyConst';
import { KeyCodes } from '../../keycode';
import { BufWrite } from '../minicap/BufWrite';
import ThirdUtils from '../ThirdUtils';
import fs from 'fs';
import Stats from '../../sync/stats';
import { parse_sequence_parameter_set } from './sps';
import { Point, ScrcpyOptions, H264Configuration, VideoStreamFramePacket } from './ScrcpyModels';
import assert from 'assert';

const PACKET_FLAG_CONFIG = BigInt(1) << BigInt(63);
const PACKET_FLAG_KEY_FRAME = BigInt(1) << BigInt(62);
const debug = Utils.debug('adb:scrcpy');

interface IEmissions {
  frame: (data: VideoStreamFramePacket) => void;
  config: (data: H264Configuration) => void;
  raw: (data: Buffer) => void;
  error: (error: Error) => void;
  disconnect: () => void;
}

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
      version: '2.3.1',
      maxSize: 600,
      maxFps: 60,
      control: false,
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
    const { version, maxSize, maxFps } = this.config;
    args.push(`CLASSPATH=${jarDest}`);
    args.push('app_process');
    args.push('/');
    args.push('com.genymobile.scrcpy.Server');
    args.push(`${version}`);
    args.push('log_level=info');
    args.push(`max_size=${maxSize}`);
    args.push(`max_fps=${maxFps}`);
    args.push('control=false');
    args.push('audio=false');
    args.push('cleanup=false');
    // args.push('send_frame_meta=true');
    // args.push('send_codec_meta=false');
    // args.push('send_device_meta=false');
    // args.push('send_dummy_byte=false');
    args.push('raw_stream=true');
    args.push(`tunnel_forward=true`);
    return args.map((a) => a.toString()).join(' ');
  }

  async start(): Promise<this> {
    if (this.closed) return this;
    const jarDest = '/data/local/tmp/scrcpy-server.jar';
    const jar = ThirdUtils.getResourcePath(`scrcpy-server-${this.config.version}.jar`);
    const srcStat: fs.Stats | null = await fs.promises.stat(jar).catch(() => null);
    const dstStat: Stats | null = await this.client.stat(jarDest).catch(() => null);
    if (!srcStat) throw Error(`fail to get ressource ${jar}`);
    if (!dstStat || srcStat.size !== dstStat.size) {
      try {
        debug(`pushing scrcpy-server.jar to ${this.client.serial}`);
        console.log('推送jar包到手机');
        const transfer = await this.client.push(jar, jarDest);
        await transfer.waitForEnd();
      } catch (e) {
        debug(`Impossible to transfer server scrcpy-server.jar to ${this.client.serial}`, e);
        throw e;
      }
    } else {
      debug(`scrcpy-server.jar already present in ${this.client.serial}, keep it`);
      console.log('jar包已经存在，跳过推送');
    }
    // Start server
    try {
      // await this.client.forward('tcp:8890', 'localabstract:scrcpy');
      Utils.delay(1000);
      const cmdLine = this._getStartupLine(jarDest);
      if (this.closed) return this;
      // console.log(`启动scrcpyServer ${cmdLine}`);
      const duplex = await this.client.shell(cmdLine);
      this.scrcpyServer = new PromiseDuplex(duplex);
      this.scrcpyServer.once('finish').then(() => {
        debug(`scrcpyServer finished on device ${this.client.serial}`);
        console.log(`scrcpyServer已停止 ${this.client.serial}`);
        this.stop();
      });
    } catch (e) {
      debug('Impossible to run server:', e);
      console.log('启动scrcpyServer失败', e);
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
    console.log(info);
    if (this.closed) return this;
    Utils.delay(1000);
    this.videoSocket = await this.client.openLocal2('localabstract:scrcpy');
    if (this.closed) {
      this.stop();
      return this;
    }
    this.controlSocket = await this.client.openLocal2('localabstract:scrcpy');
    if (this.closed) {
      this.stop();
      return this;
    }

    // this.startStreamWithMeta();
    this.startStreamRaw();
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

  private async startStreamRaw() {
    assert(this.videoSocket);
    console.log('开始推送流');
    this.videoSocket.stream.on('data', (data) => {
      this.emit('raw', data);
    });
  }

  private async startStreamWithMeta(): Promise<void> {
    assert(this.videoSocket);
    let pts = BigInt(0); // Buffer.alloc(0);
    for (;;) {
      if (!this.videoSocket) break;
      await Utils.waitforReadable(this.videoSocket, 0, 'videoSocket packet size');
      let len: number | undefined = undefined;
      const frameMeta = this.videoSocket.stream.read(12) as Buffer;
      if (!frameMeta) {
        return;
      }
      try {
        pts = frameMeta.readBigUint64BE();
        len = frameMeta.readUInt32BE(8);
        console.log(`\tHeader:PTS =`, pts);
        console.log(`\tHeader:len =`, len);
      } catch (e) {
        console.log(e);
      }
      let streamChunk: Buffer | null = null;
      while (streamChunk === null) {
        try {
          await Utils.waitforReadable(this.videoSocket, 0, 'videoSocket streamChunk');
          streamChunk = this.videoSocket.stream.read(len) as Buffer;
          if (streamChunk) {
            // /**
            //  * if pts have PACKET_FLAG_KEY_FRAME, this is a keyframe
            //  */
            // const keyframe = !!(pts & PACKET_FLAG_KEY_FRAME);
            // if (keyframe) {
            //   pts &= ~PACKET_FLAG_KEY_FRAME;
            // }
            // const frame = { keyframe, pts, data: streamChunk };
            // if (this.setFirstFrame) {
            //   this.setFirstFrame();
            //   this.setFirstFrame = undefined;
            // }
            this.emit('raw', streamChunk);
          } else {
            // large chunk.
            // console.log('fail to streamChunk len:', len);
            await Utils.delay(0);
          }
        } catch (e) {
          console.log(e);
          break;
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
