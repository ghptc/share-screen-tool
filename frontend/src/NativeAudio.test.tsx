import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {expect,test,vi} from 'vitest'
import NativeAudio from './NativeAudio'
test('native pairing requires an active screen and explicit click',async()=>{const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async path => String(path).endsWith('/watch')
  ? new Response(new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('active\n')) }}))
  : {ok:true,json:async()=>({session:'helper',code:'one-time'})} as Response);const {rerender}=render(<NativeAudio control="publisher"/>);expect(screen.getByRole('button',{name:'Pair native audio helper'})).toBeDisabled();expect(fetcher).not.toHaveBeenCalled();rerender(<NativeAudio control="publisher" screen="screen"/>);fireEvent.click(screen.getByRole('button',{name:'Pair native audio helper'}));await screen.findByLabelText('One-time native audio pairing JSON');expect(fetcher).toHaveBeenCalledWith('/api/native-audio/sessions',expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer publisher'}),body:JSON.stringify({screen:'screen'})}));rerender(<NativeAudio control="publisher"/>);await waitFor(()=>expect(fetcher).toHaveBeenCalledWith('/api/native-audio/helper/stop',expect.objectContaining({keepalive:true})))})
test('viewers have no native pairing controls',()=>{render(<NativeAudio screen="screen"/>);expect(screen.queryByRole('button')).not.toBeInTheDocument()})
test('failed authorization is shown without credentials',async()=>{vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:false,json:async()=>({error:'An active authorized screen publisher is required'})} as Response);render(<NativeAudio control="wrong" screen="screen"/>);fireEvent.click(screen.getByRole('button',{name:'Pair native audio helper'}));expect(await screen.findByRole('alert')).toHaveTextContent('authorized screen publisher')})

test('late pairing after screen stop is revoked instead of displayed',async()=>{
 let resolve!:(response:Response)=>void
 const fetcher=vi.spyOn(globalThis,'fetch').mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r})).mockResolvedValue({ok:true,json:async()=>({stopped:true})} as Response)
 const {rerender}=render(<NativeAudio control="publisher" screen="old-screen"/>);
 fireEvent.click(screen.getByRole('button',{name:'Pair native audio helper'}))
 expect(screen.getByRole('button',{name:'Pair native audio helper'})).toBeDisabled()
 rerender(<NativeAudio control="publisher"/>);
 resolve({ok:true,json:async()=>({session:'late',code:'discarded'})} as Response)
 await waitFor(()=>expect(fetcher).toHaveBeenCalledWith('/api/native-audio/late/stop',expect.anything()))
 expect(screen.queryByLabelText('One-time native audio pairing JSON')).not.toBeInTheDocument()
})

test('the owner sees waiting, verified and sharing phases from split heartbeat lines', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async path => String(path).endsWith('/watch')
    ? new Response(new ReadableStream({ start(c) { stream = c } }))
    : Response.json({session: 'helper', code: 'one-time'}))
  render(<NativeAudio control="publisher" screen="screen"/>)
  fireEvent.click(screen.getByRole('button', { name: 'Pair native audio helper' }))
  await waitFor(() => expect(stream).toBeDefined())
  const send = (text: string) => stream.enqueue(new TextEncoder().encode(text))
  send('active\nwai')
  await screen.findByLabelText('One-time native audio pairing JSON')
  send('ting\n')
  expect(await screen.findByText(/30-second startup limit/)).toBeInTheDocument()
  send('ready\n')
  expect(await screen.findByText('Stereo links ready. Waiting for audio.')).toBeInTheDocument()
  expect(screen.queryByText('Sharing audio')).toBeNull()
  send('sharing\n')
  await screen.findByText('Sharing audio')
  stream.close()
  expect(await screen.findByRole('alert')).toHaveTextContent('session ended')
})
