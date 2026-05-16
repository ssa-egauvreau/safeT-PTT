// Types for the Emscripten-generated Node IMBE module (built by
// ../web-console/cpp/build-vocoder.sh).

interface ImbeWasmModule {
  _imbe_init(): number;
  _imbe_encode(samplesPtr: number, codewordPtr: number): number;
  _imbe_decode(codewordPtr: number, samplesPtr: number): number;
  _imbe_decoder_create(): number;
  _imbe_decoder_decode(decoderPtr: number, codewordPtr: number, samplesPtr: number): number;
  _imbe_decoder_free(decoderPtr: number): void;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAP16: Int16Array;
  HEAPU8: Uint8Array;
}

declare const createImbeModule: (options?: Record<string, unknown>) => Promise<ImbeWasmModule>;
export default createImbeModule;
