import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyPlaybackLinks, verifyCaptureLinks } from './verify-routing.mjs'
const node=(id,name,serial)=>({id,type:'PipeWire:Interface:Node',info:{props:{'node.name':name,'object.serial':serial}}})
const link=(id,target)=>({id,type:'PipeWire:Interface:Link',info:{state:'active','output-node-id':10,'input-node-id':target,'output-port-id':id,'input-port-id':id+100}})
const graph=[node(10,'Firefox',1000),node(20,'HDMI',2000),node(30,'HyperX',3000),link(1,20),link(2,20)]
const streams=[{properties:{'object.serial':'1000'}}]
test('verifies actual stereo links by serial rather than requested route',()=>{
 assert.equal(verifyPlaybackLinks(graph,streams,'HDMI')[0].links.length,2)
 assert.throws(()=>verifyPlaybackLinks(graph,streams,'HyperX'))
 assert.throws(()=>verifyPlaybackLinks([...graph,link(3,30)],streams,'HDMI'))
 assert.throws(()=>verifyPlaybackLinks(graph.slice(0,-1),streams,'HDMI'))
 assert.throws(()=>verifyPlaybackLinks(graph,[{properties:{'object.serial':'999'}}],'HDMI'))
})
test('rejects duplicate capture and a wrong monitor',()=>{
 const capture=node(40,'pw-cat',4000)
 capture.info.props['media.class']='Stream/Input/Audio'
 const captureLinks=[1,2].map(id=>({id,type:'PipeWire:Interface:Link',info:{state:'active','output-node-id':30,'input-node-id':40}}))
 const current=[...graph,capture,...captureLinks]
 assert.equal(verifyCaptureLinks(current,'HyperX').captureID,40)
 assert.throws(()=>verifyCaptureLinks(current,'HDMI'))
 assert.throws(()=>verifyCaptureLinks([...current,{...capture,id:41}],'HyperX'))
})
