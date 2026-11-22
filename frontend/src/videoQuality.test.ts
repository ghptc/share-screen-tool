import { expect, test, vi } from 'vitest'
import { applyVideoTarget, nativeTarget, resolutions } from './videoQuality'

test('native defaults and sender changes preserve original layers without upscaling', async () => {
  const layers = [{ scaleResolutionDownBy: 4 }, {scaleResolutionDownBy: 1}]
  const sender = { getParameters: () => ({encodings: layers}), setParameters: vi.fn().mockResolvedValue(undefined) }
  const dimensions = { width: 2560, height: 1440 }
  expect(nativeTarget).toEqual({height:0, fps:60})
  expect(resolutions(dimensions)).toEqual([1080,720])
  await applyVideoTarget(sender as unknown as RTCRtpSender,dimensions,{height:720,fps:30})
  expect(layers).toEqual([{scaleResolutionDownBy:8,maxFramerate:30},{scaleResolutionDownBy:2,maxFramerate:30}])
  await applyVideoTarget(sender as unknown as RTCRtpSender,dimensions,nativeTarget)
  expect(layers[1]).toEqual({scaleResolutionDownBy:1,maxFramerate:60})
  await expect(applyVideoTarget(sender as unknown as RTCRtpSender,{width:640,height:360},{height:720,fps:15})).rejects.toThrow()
})
