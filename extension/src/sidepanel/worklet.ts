// @ts-nocheck
/*
 * This file deliberately uses browser-valid JavaScript despite its .ts
 * extension. Vite serves `new URL('./worklet.ts', import.meta.url)` as an
 * asset, so the AudioWorklet module must not depend on the main bundle's
 * TypeScript transform.
 *
 * It resamples the microphone's native Float32 signal to 16 kHz PCM because
 * Sarvam's streaming recognizer accepts raw s16le only. Chunks are 80 ms
 * (1,280 samples), keeping the websocket responsive without a flood of tiny
 * messages.
 */

const FALLBACK_SAMPLE_RATE = 16_000;

class SwaraPcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.targetSampleRate = options.processorOptions?.targetSampleRate || FALLBACK_SAMPLE_RATE;
    this.chunkSamples = Math.round(this.targetSampleRate * 0.08);
  }

  input = new Float32Array(0);
  readPosition = 0;
  output = [];
  levelFrames = 0;
  squaredTotal = 0;

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples?.length) return true;

    const merged = new Float32Array(this.input.length + samples.length);
    merged.set(this.input);
    merged.set(samples, this.input.length);
    this.input = merged;

    for (const sample of samples) this.squaredTotal += sample * sample;
    this.levelFrames += samples.length;
    if (this.levelFrames >= sampleRate / 12) {
      this.port.postMessage({ type: 'level', data: Math.min(1, Math.sqrt(this.squaredTotal / this.levelFrames) * 3.2) });
      this.levelFrames = 0;
      this.squaredTotal = 0;
    }

    const ratio = sampleRate / this.targetSampleRate;
    while (this.readPosition + 1 < this.input.length) {
      const index = Math.floor(this.readPosition);
      const fraction = this.readPosition - index;
      this.output.push(this.input[index] * (1 - fraction) + this.input[index + 1] * fraction);
      this.readPosition += ratio;
    }

    const consumed = Math.floor(this.readPosition);
    if (consumed > 0) {
      this.input = this.input.slice(consumed);
      this.readPosition -= consumed;
    }

    while (this.output.length >= this.chunkSamples) {
      const floats = this.output.splice(0, this.chunkSamples);
      const pcm = new Int16Array(this.chunkSamples);
      for (let index = 0; index < floats.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, floats[index]));
        pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      this.port.postMessage({ type: 'chunk', data: pcm.buffer }, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('swara-pcm-capture', SwaraPcmCapture);
