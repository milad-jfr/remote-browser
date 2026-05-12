import { chromium } from "playwright"
import fs from "fs"
import path from "path"

const STATE_DIR = "state"
const CMD = path.join(STATE_DIR, "command.json")
const RESP = path.join(STATE_DIR, "response.json")
const IMG = path.join(STATE_DIR, "live.jpg")

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR)

const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {

const browser = await chromium.launch()
const page = await browser.newPage({ viewport:{ width:1440, height:900 }})

await page.goto("https://example.com")

console.log("✅ Worker started")

// stream loop
;(async()=>{
while(true){
try{
await page.screenshot({ path: IMG, quality:60 })
}catch(e){}
await sleep(200)
}
})()

// command loop
while(true){
try{
if(fs.existsSync(CMD)){
const cmd = JSON.parse(fs.readFileSync(CMD,"utf8"))

if(cmd.processed === false){

if(cmd.type === "navigate"){
await page.goto(cmd.url)
}

if(cmd.type === "click"){
await page.mouse.click(cmd.x,cmd.y)
}

if(cmd.type === "hover"){
const box = await page.evaluate(({x,y})=>{
const el = document.elementFromPoint(x,y)
if(!el) return null
const r = el.getBoundingClientRect()
return { x:r.x, y:r.y, width:r.width, height:r.height }
},{x:cmd.x,y:cmd.y})

if(box){
fs.writeFileSync(RESP,JSON.stringify({hover:box}))
}
}

cmd.processed=true
fs.writeFileSync(CMD,JSON.stringify(cmd,null,2))
}
}
}catch(e){}

await sleep(100)
}

})()
