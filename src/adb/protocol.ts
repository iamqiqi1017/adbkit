/**
 * adb Protocol is a 4 byte prefixed message.
 * the 4 fisrt byte can be on of the 10 predefined Code, of a 4-hexa string indicating the message len.
 */
export default class Protocol {
  public static OKAY = 'OKAY';
  public static FAIL = 'FAIL';
  public static STAT = 'STAT';
  public static LIST = 'LIST';
  public static DENT = 'DENT';
  public static RECV = 'RECV';
  public static DATA = 'DATA';
  public static DONE = 'DONE';
  public static SEND = 'SEND';
  public static QUIT = 'QUIT';

  public static bOKAY = Buffer.from('OKAY');
  public static bFAIL = Buffer.from('FAIL');
  public static bSTAT = Buffer.from('STAT');
  public static bLIST = Buffer.from('LIST');
  public static bDENT = Buffer.from('DENT');
  public static bRECV = Buffer.from('RECV');
  public static bDATA = Buffer.from('DATA');
  public static bDONE = Buffer.from('DONE');
  public static bSEND = Buffer.from('SEND');
  public static bQUIT = Buffer.from('QUIT');

  /**
   * parse a 4 char string
   */
  static decodeLength(length: string): number {
    return parseInt(length, 16);
  }
  /**
   * 
   * @param length message len
   * @returns message len as a 4 char string
   */
  static encodeLength(length: number): string {
    return length.toString(16).padStart(4, '0').toUpperCase();
  }
  /**
   * prefix a chunk with it's len stored in a 4 char hexa string, so data len can not exceed 0Xffff
   * @param data string or buffer to send.
   * @returns data as a Buffer prefixed by a 4 char Base16 length chunk
   */
  static encodeData(data: Buffer | string): Buffer {
    if (!Buffer.isBuffer(data)) {
      data = Buffer.from(data);
    }
    const len = Protocol.encodeLength(data.length);
    return Buffer.concat([Buffer.from(len), data]);
  }
}
