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

let App = connect(s => s)(({ inputs,input }) => h('div', {},
  h(SourceSelector, {inputs,input})
))

render(h(Provider, {store}, h(App)), document.getElementById('app'))

class Beeper {
  constructor() {
    this.ctx = new AudioContext()
    this.notes = Object.create(null)
  }
  
  _freshOscillator() {
    let osc = this.ctx.createOscillator()
    let vol = this.ctx.createGain()
    osc.connect(osc._gainNode = vol)
    vol.connect(this.ctx.destination)
    vol.gain.value = 0    // n.b.
    osc.type = 'sawtooth'
    return osc
  }
  
  _noteToFrequency(n) {
    return 440 * 2 ** ((n - 69) / 12)
  }
  
  _velocityToGain(v) {
    return v / 128 / 10
  }
  
  playNote(n,v) {
    let osc = this.notes[n] || this._freshOscillator()
    osc.frequency.value = this._noteToFrequency(n)
    osc._gainNode.gain.setTargetAtTime(this._velocityToGain(v), 0, 0.02)
    if (!this.notes[n]) {
      this.notes[n] = osc
      osc.start()
    }
  }
  
  stopNote(n) {
    let osc = this.notes[n]
    if (osc) {
      osc._gainNode.gain.setTargetAtTime(0,0,0.1)
      setTimeout(_ => {   // ~HACK: clean up eventually
        osc.stop()
        // TODO: need we disconnect?
      }, 1e3)
    }
    delete this.notes[n]
  }
  
  
}

class Looper {
  constructor(store) {
    this.store = store
    this._bindMarkedMethods()
  }
  _bindMarkedMethods() {
    // ~HACK: fill in for missing https://tc39.github.io/proposal-class-public-fields/
    const P = "BIND_"
    Object.getOwnPropertyNames(Object.getPrototypeOf(this)).forEach(k => {
      if (k.indexOf(P) === 0) {
        this[k.slice(P.length)] = this[k].bind(this)
      }
    })
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
    this.store.setState({inputs})
  }
  
  BIND_handleMessage(evt) {
    let [status, data1, data2] = evt.data
    switch (status >> 4) {
      case 0x8:
        this.beeper.stopNote(data1)
        break
      case 0x9:
        this.beeper.playNote(data1, data2)
        break
    }
  }
  
  use(port) {
    let { input:prev } = this.store.getState()
    if (prev) prev.removeEventListener('midimessage', this.handleMessage, false)
    if (port) port.addEventListener('midimessage', this.handleMessage, false)
    this.store.setState({input:port})
  }
}

let beeper = new Beeper(),
    looper = new Looper(store)
looper.start(beeper)
