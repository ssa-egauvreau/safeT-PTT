openWakeWord model assets for the on-device wake-word gate.

Drop three TFLite files here (kept uncompressed via build.gradle noCompress "tflite"):

  melspectrogram.tflite   - shared openWakeWord front-end (pretrained)
  embedding_model.tflite  - shared openWakeWord embedding model (pretrained)
  <phrase>.tflite         - the per-phrase classifier you train, named by the
                            slugged wake word. "hey ai" -> hey_ai.tflite

Until these exist, OpenWakeWordSpotter self-disables and the gate is a no-op
(every AI clip transcribes as usual). See docs/ai-dispatch-wake-word-on-device.md
for the training recipe and how to turn the gate on after measuring accuracy.
