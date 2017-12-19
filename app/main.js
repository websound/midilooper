"use strict";


const { createStore } = unistore

let store = createStore({ inputs:null, input:null })

const { Component, render, h } = preact
const { Provider, connect } = unistore

let SourceSelector = ({ inputs, input }) => h('div', {class:"source-selector"},
  h('h2', {}, "MIDI Input"),
  (inputs) ? h('select', {
    onChange: evt => {
      let idx = evt.target.selectedIndex - 1  // (account for --- option)
      looper.use(inputs[idx] || null)
    }
  },
    h('option', {selected:!input}, '---'),
    inputs.map(obj => h('option', {
      selected: (obj === input)
    }, obj.name))
  ) : h('span', {}, "No MIDI access!")
)

class RecordButton extends Component {
  constructor(props) {
    super(props)
    bindMarkedMethods.call(this) 
  }
  
  BIND_handleToggle(evt) {
    if (evt.type === 'click' || evt.code === "Space") looper.toggleRecording(evt)
  }
  
  componentDidMount() {
    window.addEventListener('keyup', this.handleToggle, false)
  }
  componentWillUnmount() {
    window.removeEventListener('keyup', this.handleToggle, false)
  }
  render() {
    return h('button', {type:'button',onClick:this.handleToggle}, "Record")
  }
}

let App = connect(s => s)(({ inputs,input }) => h('div', {},
  h(SourceSelector, {inputs,input}),
  h(RecordButton, {})
))

render(h(Provider, {store}, h(App)), document.getElementById('app'))


class Beeper {
  constructor() {
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
    }
  }
}

function bindMarkedMethods() {
  // ~HACK: fill in for missing https://tc39.github.io/proposal-class-public-fields/
  const P = "BIND_"
  Object.getOwnPropertyNames(Object.getPrototypeOf(this)).forEach(k => {
    if (k.indexOf(P) === 0) {
      this[k.slice(P.length)] = this[k].bind(this)
    }
  })
}


class Looper {
  constructor(store) {
    this.store = store
    bindMarkedMethods.call(this)
  }
  
  async start(beeper) {
    this.beeper = beeper
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
    this.beeper = null
  }
  
  BIND_updatePorts() {
    let inputs = Array.from(this.midi.inputs.values())
    let {input} = store.getState()
    if (input && input.state === 'disconnected') this.use(input = null)
    this.store.setState({inputs,input})
    if (!input && inputs.length === 1) this.use(input = inputs[0])
  }
  
  BIND_handleMessage(evt) {
    if (this.recording) this.events.push({
      data: evt.data,
      time: evt.timeStamp
    })
    this.beeper.send(evt.data, evt.timeStamp)
  }
  
  use(port) {
    let { input:prev } = this.store.getState()
    if (prev) prev.removeEventListener('midimessage', this.handleMessage, false)
    if (port) port.addEventListener('midimessage', this.handleMessage, false)
    this.store.setState({input:port})
  }
  
  startRecording(ts) {
    this.events = []
    this.startTime = ts
    this.recording = true
  }
  
  stopRecording(ts) {
    this.endTime = ts
    this.recording = false
  }
  
  toggleRecording(evt) {
    if (!this.recording) this.startRecording(evt.timeStamp)
    else {
      this.stopRecording(evt.timeStamp)
      this.startPlayback()
    }
console.log( (this.recording) ? "RECORDING" : "PLAYING" )
  }
  
  _queueRepeat(i) {
    let nextStart = performance.now() + i * (this.endTime - this.startTime)
    let offset = nextStart - this.startTime
    this.events.forEach(({data,time}) => this.beeper.send(data,time+offset))
  }
  
  
  startPlayback() {
    let i = 0
    let delay = this.endTime - this.startTime - 0.5
    let trigger = function () {
      this._queueRepeat(i++)
      setTimeout(trigger, delay / 1000)
    }.bind(this)
    trigger()
  }
  
  stopPlayback() {}
}

let beeper = new Beeper(),
    looper = new Looper(store)
looper.start(beeper)
