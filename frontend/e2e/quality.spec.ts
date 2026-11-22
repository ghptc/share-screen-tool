import {test,expect} from '@playwright/test'
import {generatedCapture} from './generated-capture'

test('publish native capture then downscale and restore without another picker',async ({browser,baseURL})=>{
  const pub=await browser.newContext(), sub=await browser.newContext()
  try {
    await generatedCapture(pub,{width:1920,height:1080,fps:30})
    const sender=await pub.newPage(), viewer=await sub.newPage()
    for(const p of [sender,viewer]){await p.goto(baseURL!);await expect(p.locator('.connection')).toHaveText('Connected')}
    await sender.getByLabel('Share audio',{exact:true}).uncheck()
    await sender.getByRole('button',{name:'Start sharing'}).click()
    await expect(sender.getByRole('button',{name:'Stop sharing'})).toBeVisible()
    await sender.getByRole('button',{name:'Quality',exact:true}).click()
    await expect(sender.getByLabel('Publish FPS')).toHaveValue('60')
    await expect(sender.getByLabel('Publish resolution')).toHaveValue('0')
    expect(await sender.evaluate(()=>window.__screenTest.requested[0].video)).toEqual({frameRate:{ideal:60,max:60}})
    await viewer.bringToFront()
    const height=()=>viewer.locator('video').evaluate((v: HTMLVideoElement)=>v.videoHeight)
    await expect.poll(height,{timeout:25000}).toBe(1080)
    await sender.getByLabel('Publish FPS').selectOption('30')
    await sender.getByLabel('Publish resolution').selectOption('720')
    await expect.poll(height,{timeout:25000}).toBe(720)
    await viewer.getByRole('button',{name:'Quality',exact:true}).click()
    await viewer.getByText('Runtime diagnostics').click()
    const stats=viewer.locator('.media-diagnostics dl')
    await expect(stats).toContainText('1280 × 720')
    await expect.poll(()=>stats.innerText()).toMatch(/Decoded FPS\s+[\d.]+/)
    console.log('Generated 720p receiver sample', await stats.innerText())
    await sender.getByLabel('Publish resolution').selectOption('0')
    await expect.poll(height,{timeout:25000}).toBe(1080)
    expect(await sender.evaluate(()=>window.__screenTest.calls)).toBe(1)
    await sender.getByRole('button',{name:'Stop sharing'}).click()
    await expect(viewer.locator('video')).toHaveCount(0)
  }finally{await pub.close();await sub.close()}
})
