package com.securityradio.ptt.device

import android.content.Context
import android.util.Log
import org.tensorflow.lite.Interpreter
import java.io.FileNotFoundException
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * openWakeWord-based [WakeWordSpotter] (Apache-2.0 models). Runs the standard three-stage TFLite
 * pipeline over the utterance the [WakeWordGate] buffered:
 *
 *   16 kHz int16 PCM ──► melspectrogram.tflite ──► embedding_model.tflite ──► <wakeword>.tflite ──► score
 *
 * The melspectrogram + embedding front-ends are the shared pretrained openWakeWord models; the
 * `<wakeword>.tflite` classifier is the per-phrase model trained for the agency wake word (see
 * `docs/ai-dispatch-wake-word-on-device.md`). All three live under `assets/wakeword/`.
 *
 * SAFETY: this **self-disables** — if any model asset is missing or its tensor shapes don't match
 * what this pipeline expects, [classify] returns [WakeHint.MAYBE] (the server then transcribes as
 * usual). So shipping the app without the model files, or with a mismatched model, changes nothing.
 *
 * ON-DEVICE VERIFICATION: the preprocessing constants below ([MEL_BINS], the mel post-scale, the
 * embedding window/stride, the int16→float convention) follow the published openWakeWord runtime,
 * but should be confirmed against the actual model files the first time real models are dropped in —
 * a mismatch is caught and self-disables rather than misbehaving.
 */
class OpenWakeWordSpotter(
    context: Context,
    private val highThreshold: Float = 0.5f,
    private val lowThreshold: Float = 0.1f,
) : WakeWordSpotter {

    private val appCtx = context.applicationContext
    private val mel: Interpreter? = loadModel(MEL_MODEL)
    private val embed: Interpreter? = loadModel(EMBED_MODEL)
    /** Wakeword classifiers are keyed by phrase slug so several can ship at once. */
    private val classifiers = HashMap<String, Interpreter?>()

    private val ready: Boolean = mel != null && embed != null
    @Volatile private var warned = false

    private fun loadModel(name: String): Interpreter? = try {
        appCtx.assets.openFd("$ASSET_DIR/$name").use { fd ->
            fd.createInputStream().channel.use { ch ->
                val buf = ch.map(java.nio.channels.FileChannel.MapMode.READ_ONLY, fd.startOffset, fd.declaredLength)
                Interpreter(buf, Interpreter.Options().apply { numThreads = 1 })
            }
        }
    } catch (_: FileNotFoundException) {
        null // model not shipped yet — spotter stays inert
    } catch (t: Throwable) {
        Log.w(TAG, "Failed to load wake-word model $name", t)
        null
    }

    private fun classifierFor(wakeWord: String): Interpreter? {
        val slug = slug(wakeWord)
        return classifiers.getOrPut(slug) { loadModel("$slug.tflite") }
    }

    override fun classify(pcm16: ByteArray, length: Int, wakeWord: String): WakeHint {
        if (!ready) return notReady()
        val ww = classifierFor(wakeWord) ?: return notReady()
        return try {
            val score = runPipeline(pcm16, length, ww)
            when {
                score >= highThreshold -> WakeHint.CLEAR
                score >= lowThreshold -> WakeHint.MAYBE
                else -> WakeHint.NONE
            }
        } catch (t: Throwable) {
            // Any shape/runtime mismatch must never harm a transmission — fall back to "transcribe".
            if (!warned) {
                warned = true
                Log.w(TAG, "Wake-word inference failed; spotter disabled for this session", t)
            }
            WakeHint.MAYBE
        }
    }

    /** Run mel → sliding embeddings → sliding classifier, returning the peak wake score. */
    private fun runPipeline(pcm16: ByteArray, length: Int, classifier: Interpreter): Float {
        val melFrames = computeMel(pcm16, length) // [frames][MEL_BINS]
        if (melFrames.size < EMBED_WINDOW) return 0f

        // Slide an EMBED_WINDOW-frame window (stride EMBED_STRIDE) to produce 96-d embeddings.
        val embeddings = ArrayList<FloatArray>()
        var i = 0
        while (i + EMBED_WINDOW <= melFrames.size) {
            embeddings.add(embedWindow(melFrames, i))
            i += EMBED_STRIDE
        }
        if (embeddings.size < WW_WINDOW) return 0f

        // Slide a WW_WINDOW-embedding window through the classifier; the utterance score is the peak.
        var peak = 0f
        var j = 0
        while (j + WW_WINDOW <= embeddings.size) {
            peak = maxOf(peak, scoreWindow(classifier, embeddings, j))
            j += 1
        }
        return peak
    }

    private fun computeMel(pcm16: ByteArray, length: Int): Array<FloatArray> {
        val m = mel ?: return emptyArray()
        val samples = length / 2
        // openWakeWord feeds raw int16 audio as float (NOT normalized to ±1).
        val audio = FloatArray(samples)
        val bb = ByteBuffer.wrap(pcm16, 0, length).order(ByteOrder.LITTLE_ENDIAN)
        for (k in 0 until samples) audio[k] = bb.short.toFloat()

        m.resizeInput(0, intArrayOf(1, samples))
        m.allocateTensors()
        val out = m.getOutputTensor(0).shape() // expected [1, 1, frames, MEL_BINS] or [1, frames, MEL_BINS]
        val frames = out[out.size - 2]
        val bins = out[out.size - 1]
        if (bins != MEL_BINS) throw IllegalStateException("mel bins=$bins != $MEL_BINS")
        val raw = Array(1) { Array(1) { Array(frames) { FloatArray(bins) } } }
        // Input shape [1, samples]; output [1, 1, frames, MEL_BINS] (a shape mismatch throws and
        // self-disables — see the class doc).
        m.run(arrayOf(audio), raw)
        // openWakeWord mel post-scaling so the embedding model sees the expected range.
        val result = Array(frames) { f -> FloatArray(bins) { b -> raw[0][0][f][b] / 10f + 2f } }
        return result
    }

    private fun embedWindow(mel: Array<FloatArray>, start: Int): FloatArray {
        val e = embed!!
        // Embedding input [1, EMBED_WINDOW, MEL_BINS, 1].
        val input = Array(1) { Array(EMBED_WINDOW) { f -> Array(MEL_BINS) { b -> floatArrayOf(mel[start + f][b]) } } }
        val out = Array(1) { Array(1) { Array(1) { FloatArray(EMBED_DIM) } } }
        e.run(input, out)
        return out[0][0][0]
    }

    private fun scoreWindow(classifier: Interpreter, embeddings: List<FloatArray>, start: Int): Float {
        // Classifier input [1, WW_WINDOW, EMBED_DIM], output [1, 1].
        val input = Array(1) { Array(WW_WINDOW) { embeddings[start + it] } }
        val out = Array(1) { FloatArray(1) }
        classifier.run(input, out)
        return out[0][0]
    }

    private fun notReady(): WakeHint {
        if (!warned) {
            warned = true
            Log.i(TAG, "Wake-word models not present; gate is inert (server transcribes as usual)")
        }
        return WakeHint.MAYBE
    }

    override fun close() {
        runCatching { mel?.close() }
        runCatching { embed?.close() }
        classifiers.values.forEach { runCatching { it?.close() } }
    }

    companion object {
        private const val TAG = "OpenWakeWordSpotter"
        private const val ASSET_DIR = "wakeword"
        private const val MEL_MODEL = "melspectrogram.tflite"
        private const val EMBED_MODEL = "embedding_model.tflite"

        // openWakeWord front-end shapes — verify against the shipped models on first integration.
        private const val MEL_BINS = 32
        private const val EMBED_WINDOW = 76 // mel frames per embedding
        private const val EMBED_STRIDE = 8
        private const val EMBED_DIM = 96
        private const val WW_WINDOW = 16 // embeddings per classifier decision

        /** "Hey AI" → "hey_ai" (matches the trained classifier asset filename). */
        fun slug(wakeWord: String): String =
            wakeWord.trim().lowercase()
                .replace(Regex("[^a-z0-9]+"), "_")
                .trim('_')
                .ifEmpty { "hey_ai" }
    }
}
