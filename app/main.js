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
    this.store.setState({inputs})
  }
  
  BIND_handleMessage(evt) {
    console.log(evt)
  }
  
  use(port) {
    let { input:prev } = this.store.getState()
    if (prev) prev.removeEventListener('midimessage', this.handleMessage, false)
    if (port) port.addEventListener('midimessage', this.handleMessage, false)
    this.store.setState({input:port})
  }
}

let looper = new Looper(store)
looper.start()
