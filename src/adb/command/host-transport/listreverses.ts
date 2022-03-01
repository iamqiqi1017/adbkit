import Protocol from '../../protocol';
import Command from '../../command';
import Reverse from '../../../Reverse';

export default class ListReversesCommand extends Command<Reverse[]> {
  async execute(): Promise<Reverse[]> {
    this._send('reverse:list-forward');
    const reply = await this.parser.readAscii(4);
    switch (reply) {
      case Protocol.OKAY:
        return this.parser.readValue().then((value) => {
          return this._parseReverses(value);
        });
      case Protocol.FAIL:
        return this.parser.readError();
      default:
        return this.parser.unexpected(reply, 'OKAY or FAIL');
    }
  }

  private _parseReverses(value: Buffer): Reverse[] {
    const reverses: Reverse[] = [];
    const ref = value.toString().split('\n');
    for (let i = 0, len = ref.length; i < len; i++) {
      const reverse = ref[i];
      if (reverse) {
        const [, remote, local] = reverse.split(/\s+/);
        reverses.push({ remote, local });
      }
    }
    return reverses;
  }
}
