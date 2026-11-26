// Score stored fixture frames offline. ffmpeg writes statistics to a null sink.
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function installImageSample() {
  let frames = 0, first, last, reference
  const chunks = []
  const toBase64 = bytes => bytes.toBase64()
  window.imageSample = {
    input(frame) {
      if (frames >= 8) return false
      frames++
      if (frames === 1) first = frame.timestamp
      if (frames === 8) { last = frame.timestamp; reference = frame.clone() }
      return frames === 1
    },
    output(chunk) {
      if (first === undefined || chunk.timestamp < first || (last !== undefined && chunk.timestamp > last)) return
      const bytes = new Uint8Array(chunk.byteLength)
      chunk.copyTo(bytes)
      chunks.push(toBase64(bytes))
    },
    async finish() {
      if (!reference || chunks.length !== 8) throw Error('Fidelity sample incomplete')
      try {
        const canvas = new OffscreenCanvas(reference.displayWidth, reference.displayHeight)
        canvas.getContext('2d').drawImage(reference, 0, 0)
        const png = await canvas.convertToBlob()
        return { chunks, png: toBase64(new Uint8Array(await png.arrayBuffer())) }
      } finally { reference.close() }
    },
  }
}

export async function scoreImage(codec, { chunks, png }, width, height) {
  const dir = await mkdtemp(join(tmpdir(), 'screen-share-fixture-'))
  try {
    const buffers = chunks.map(s => Buffer.from(s, 'base64'))
    let file = join(dir, 'sample.h264')
    if (codec === 'h264') await writeFile(file, Buffer.concat(buffers)) // Annex B
    else {
      file = join(dir, 'sample.ivf')
      const header = Buffer.alloc(32)
      header.write('DKIF'); header.writeUInt16LE(32, 6)
      header.write({ vp8: 'VP80', vp9: 'VP90', av1: 'AV01' }[codec], 8)
      header.writeUInt16LE(width, 12); header.writeUInt16LE(height, 14)
      header.writeUInt32LE(60, 16); header.writeUInt32LE(1, 20); header.writeUInt32LE(buffers.length, 24)
      const blocks = [header]
      buffers.forEach((bytes, i) => {
        const frame = Buffer.alloc(12)
        frame.writeUInt32LE(bytes.length); frame.writeBigUInt64LE(BigInt(i), 4)
        blocks.push(frame, bytes)
      })
      await writeFile(file, Buffer.concat(blocks))
    }
    const original = join(dir, 'source.png')
    await writeFile(original, Buffer.from(png, 'base64'))
    const crop = 'crop=512:256:64:64,scale=out_range=full,format=gray,setpts=PTS-STARTPTS'
    const result = {}
    for (const filter of ['psnr', 'ssim']) {
      const stat = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-i', original, '-filter_complex',
        `[0:v]select=eq(n\\,7),${crop}[a];[1:v]${crop}[b];[a][b]${filter}=stats_file=-`,
        '-frames:v', '1', '-an', '-f', 'null', '-'], { encoding: 'utf8' })
      const value = stat.match(filter === 'psnr' ? /psnr_avg:([\d.]+|inf)/ : /All:([\d.]+)/)?.[1]
      if (!value) throw Error('Missing ' + filter + ' statistic')
      result[filter] = value === 'inf' ? 'infinite' : Number(value)
    }
    return result
  } finally { await rm(dir, { recursive: true, force: true }) }
}
