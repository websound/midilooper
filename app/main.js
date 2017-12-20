"use strict";


const { createStore } = unistore

let store = createStore({ inputs:null, input:null, status:null })

const { Component, render, h } = preact
const { Provider, connect } = unistore

let Selector = ({ options, selectedOption, onSelect }) => h('select', {
  onChange: evt => {
    let idx = evt.target.selectedIndex - 1  // (account for --- option)
    if (onSelect) onSelect(options[idx] || null)
    
  }
},
  h('option', {selected:!selectedOption}, '---'),
  options.map(option => h('option', {
    selected: (option === selectedOption)
  }, option.name))
)

let InputSelector = ({ inputs, input }) => h('div', {class:"input port-selector"},
  h('h2', {}, "Input"),
  (inputs) ? h(Selector, {
    options:inputs, selectedOption:input,
    onSelect: input => looper.use(input)
  }) : h('span', {}, "No MIDI access!")
)

let OutputSelector = ({ outputs, output }) => h('div', {class:"output port-selector"},
  h('h2', {}, "Output"),
  (outputs) ? h(Selector, {
    options:outputs, selectedOption:output,
    onSelect: output => looper.sendTo(output)
  }) : h('span', {}, "No MIDI access!")
)

let MidiControls = ({ inputs,input, outputs,output }) => h('div', {class:"midi-controls"},
  h(InputSelector, {inputs,input}),
  h(OutputSelector, {outputs,output}),
)



class RecordButton extends Component {
  constructor(props) {
    super(props)
    bindMarkedMethods.call(this) 
  }
  
  BIND_handleToggle(evt) {
    if (evt.type === 'click' || evt.code === "Space") {
      let recording = looper.toggleRecording(evt)
      this.setState({recording})
    }
  }
  
  componentDidMount() {
    window.addEventListener('keyup', this.handleToggle, false)
  }
  componentWillUnmount() {
    window.removeEventListener('keyup', this.handleToggle, false)
  }
  render() {
    let recording = this.state.recording
    return h('button', {class:"main-switch",type:'button',onClick:this.handleToggle}, (recording) ? "Play" : "Record")
  }
}

let App = connect(s => s)(({ inputs,input, outputs,output }) => h('div', {},
  h(MidiControls, {inputs,input,outputs,output}),
  h('br'),
  h(RecordButton, {}),
  
))


function bindMarkedMethods() {
  // ~HACK: fill in for missing https://tc39.github.io/proposal-class-public-fields/
  const P = "BIND_"
  Object.getOwnPropertyNames(Object.getPrototypeOf(this)).forEach(k => {
    if (k.indexOf(P) === 0) {
      this[k.slice(P.length)] = this[k].bind(this)
    }
  })
}

class Beeper {
  constructor(name) {
    this.name = name
    this.ctx = new AudioContext()
    this.notes = Object.create(null)
  }
  
  _freshOscillator(freq) {
    let osc = this.ctx.createOscillator()
    let vol = this.ctx.createGain()
    osc.connect(osc._gainNode = vol)
    vol.connect(this.ctx.destination)
    vol.gain.setValueAtTime(0,0)    // n.b.
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(freq,0)
    return osc
  }
  
  _noteToFrequency(n) {
    return 440 * 2 ** ((n - 69) / 12)
  }
  
  _velocityToGain(v) {
    return v / 128 / 10
  }
  
  _hiresToTime(t) {
    if (t === 0) t = performance.now()
    // see https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp
    var at = this.ctx.getOutputTimestamp()
    return at.contextTime + (t - at.performanceTime) / 1000
  }
  
  schedule(n,v,t=0,c=0) {
    let osc = this.notes[n]
    if (!osc) {
      this.notes[n] = osc = this._freshOscillator(this._noteToFrequency(n))
      osc.start()
    }
    osc._gainNode.gain.setTargetAtTime(this._velocityToGain(v), this._hiresToTime(t), c)
    // TODO: clean up oscillators when they haven't been heard for a while?
  }
  
  playNote(n,v,t=0) {
    this.schedule(n,v,t,0.1)
  }
  
  stopNote(n,t=0) {
    this.schedule(n,0,t,0.05)
  }
  
  stopAll(t=0) {
    Object.keys(this.notes).forEach(n => this.schedule(n,0,t,0))
  }
  
  // c.f. https://www.w3.org/TR/webmidi/#midioutput-interface
  send(bytes, ts=0) {
    // TODO: handle multiple messages
    
    let [status, data1, data2] = bytes
    switch (status >> 4) {
      case 0x8:
        this.stopNote(data1, ts)
        break
      case 0x9:
        this.playNote(data1, data2, ts)
        break
      case 0xB:
        if (data1 === 0x7B) this.stopAll(ts)
        break
    }
  }
  clear() {
    // TODO: this should cancel buffered events… ours are ± already forwarded along
  }
}

class NoteWatcher {
  constructor() {
    this.clear()
  }
  
  send(msg) {
    let [status, n, v] = msg
    let c = status & 0x0F;
    switch (status >> 4) {
      case 0x8:
        delete this._notesByChannel[c][n]
        break
      case 0x9:
        this._notesByChannel[c][n] = v
        break
    }
  }
  
  clear() {
    this._notesByChannel = Array(16).fill(null).map(_ => Object.create(null))
  }
  
  messages(play) {
    let s = (play) ? 0x90 : 0x80
    let channelEvents = this._notesByChannel.map((notes, c) => Object.entries(notes).map(([n,v]) => (
      [s|c, n, (play) ? v : 0]
    )))
    return channelEvents.reduce((acc,arr) => [...acc, ...arr], [])
  }
  
}

class Track {
  constructor(events, duration) {
    bindMarkedMethods.call(this)
    this.loop = false
    this.output = null
    
    this._events = events
    this._duration = duration
    this._startTime = null
    this._prevIndex = 0
    this._groupTime = 30      // TODO: increase when page is backgrounded
  }
  
  BIND_queueNextGroup() {
    if (!this.playing) return
    
    let now = performance.now()
    let evtOffset = this._startTime
    let cutoffTime = now + this._groupTime
    
    let nextTime = null
    let evtIdx = this._prevIndex
    while (evtIdx < this._events.length) {
      let {data, time:_time} = this._events[evtIdx]
      let time = _time + evtOffset
      if (time > cutoffTime) {
        nextTime = time
        break;
      }
      this._watcher.send(data)
      if (this.output) this.output.send(data,time)
      evtIdx += 1
    }
    this._prevIndex = evtIdx
    if (nextTime) {
      setTimeout(this.queueNextGroup, nextTime - now)
    } else if (this.loop) {
      this.play(this._startTime + this._duration)
    }
  }
  
  play(t=performance.now()) {
    this._startTime = t
    this._prevIndex = 0
    this._watcher = new NoteWatcher()
    this.playing = true
    if (this._events.length) this.queueNextGroup()
  }
  
  stop() {
    this.playing = false
    this._watcher.messages(false).forEach(msg => this.output.send(msg))
    this._watcher = null
  }
}

class Looper {
  constructor(store) {
    this.store = store
    this.noteWatcher = new NoteWatcher()
    bindMarkedMethods.call(this)
  }
  
  async start() {
    try {
      this.midi = await navigator.requestMIDIAccess(/*{sysex:true}*/)
      this.midi.addEventListener('statechange', this.updatePorts, false)
      this.updatePorts()
    } catch (e) {
      console.error("Failed to gain MIDI access.", e)
    }
  }
  
  stop() {
    this.midi.removeEventListener('statechange', this.updatePorts, false)
    this.midi = null
  }
  
  BIND_updatePorts() {
    let inputs = Array.from(this.midi.inputs.values())
    let {input} = store.getState()
    if (input && input.state === 'disconnected') this.use(input = null)
    if (!input) this.use(input = inputs[0])
    this.store.setState({inputs,input})
    
    let outputs = [beeper, ...this.midi.outputs.values()]
    let {output} = store.getState()
    if (output && output.state === 'disconnected') this.sendTo(output = null)
    if (!output) this.sendTo(output = outputs[0])
    this.store.setState({outputs,output})
  }
  
  BIND_handleMessage(evt) {
    this.noteWatcher.send(evt.data)
    if (this.recording) this.events.push({
      data: evt.data,
      time: evt.timeStamp
    })
    if (this.output) this.output.send(evt.data, evt.timeStamp)
  }
  
  use(port) {
    let { input:prev } = this.store.getState()
    if (prev) prev.removeEventListener('midimessage', this.handleMessage, false)
    if (port) port.addEventListener('midimessage', this.handleMessage, false)
    this.store.setState({input:port})
  }
  
  sendTo(port) {
    this.output = port
    if (this.track) this.track.output = port
  }
  
  
  startRecording(ts) {
    this.events = []
    this.events.push(...this.noteWatcher.messages(true).map(data => ({time:ts,data})))
    this.startTime = ts
    this.recording = true
  }
  
  stopRecording(ts) {
    this.events.push(...this.noteWatcher.messages(false).map(data => ({time:ts,data})))
    this.endTime = ts
    this.recording = false
  }
  
  toggleRecording(evt) {
    if (!this.recording) {
      this.stopPlayback()
      this.startRecording(evt.timeStamp)
    } else {
      this.stopRecording(evt.timeStamp)
      this.startPlayback()
    }
    return this.recording;
  }
  
  startPlayback() {
    let events = this.events.map(({data,time}) => ({data,time:time-this.startTime}))
    let duration = this.endTime - this.startTime
    this.track = new Track(events,duration)
    this.track.output = this.output
    this.track.loop = true
    this.track.play(this.endTime)
  }
  
  stopPlayback() {
    if (this.track) this.track.stop()
  }
}


let beeper = new Beeper("Soft Synth"),
    looper = new Looper(store)
looper.start()

render(h(Provider, {store}, h(App)), document.getElementById('app'))
