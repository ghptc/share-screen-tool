// Read-only validation of actual direct PipeWire links, not requested targets.
export function verifyPlaybackLinks(graph, streams, targetName) {
 const nodes=graph.filter(n=>n.type.endsWith(':Node'))
 const target=nodes.find(n=>n.info?.props?.['node.name']===targetName)
 if(!target)throw new Error('Requested playback node disappeared')
 const links=graph.filter(n=>n.type.endsWith(':Link')&&n.info?.state==='active')
 return streams.map(stream=>{
  const serial=stream.properties?.['object.serial']
  const node=nodes.find(n=>String(n.info?.props?.['object.serial'])===String(serial))
  if(!node||serial===undefined)throw new Error('Cannot identify browser stream in PipeWire graph')
  const outgoing=links.filter(l=>l.info['output-node-id']===node.id)
  if(outgoing.length<2||outgoing.some(l=>l.info['input-node-id']!==target.id))throw new Error('Browser playback is not linked exclusively in stereo to the requested output')
  return {streamSerial:serial,nodeID:node.id,targetID:target.id,links:outgoing.map(l=>({id:l.id,outputPort:l.info['output-port-id'],inputPort:l.info['input-port-id']}))}
 })
}

export function verifyCaptureLinks(graph, sourceName) {
 const nodes=graph.filter(n=>n.type.endsWith(':Node'))
 const source=nodes.find(n=>n.info?.props?.['node.name']===sourceName)
 const captures=nodes.filter(n=>n.info?.props?.['node.name']==='pw-cat'&&n.info.props['media.class']==='Stream/Input/Audio')
 if(!source||captures.length!==1)throw new Error('Expected exactly one pw-cat capture and the selected monitor source')
 const links=graph.filter(n=>n.type.endsWith(':Link')&&n.info?.state==='active'&&n.info['input-node-id']===captures[0].id)
 if(links.length!==2||links.some(l=>l.info['output-node-id']!==source.id))throw new Error('Capture is not exclusively linked to the selected stereo sink monitor')
 return {sourceID:source.id,captureID:captures[0].id,links:links.map(l=>l.id)}
}
