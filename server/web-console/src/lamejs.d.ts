// Minimal typings for lamejs (the package ships none). Only the MP3 encoder
// surface the console uses for exporting transmission audio.
declare module "lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
}
