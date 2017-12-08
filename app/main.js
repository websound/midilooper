"use strict";

class Looper {
  constructor() {
    this.log = evt => console.log(evt)
  }
  
  use(port) {
    let { port:prev, log } = this
    console.log("LOG?", log, port)
    if (prev) prev.removeEventListener('midimessage', log, true)
    if (port) port.onmidimessage = function (msg) { console.log(msg); };
    this.port = port
    console.log("Using", port)
  }
}

let looper = new Looper()


const { createStore } = unistore

let store = createStore({ inputs:null, input:null })

let actions = store => ({
  selectInput({ input:prev }, port) {
    looper.use(port)
  }
})

const { Component, render, h } = preact
const { Provider, connect } = unistore

let SourceSelector = ({ inputs }) => h('div', {class:"source-selector"},
  h('h2', {}, "MIDI Input"),
  (inputs) ? h('select', {
    onChange: evt => {
      let idx = evt.target.selectedIndex - 1  // (account for --- option)
      looper.use(inputs[idx] || null)
    }
  },
    h('option', {}, '---'),
    inputs.map(obj => h('option', {
      'myprop': obj
    }, obj.name))
  ) : h('span', {}, "No inputs.")
)

let App = connect(s => s)(({ inputs }) => h('div', {},
  h(SourceSelector, {inputs})
))

render(h(Provider, {store},
  h(App)
), document.getElementById('app'))


async function run() {
  try {
    // TODO: move this to Looper
    let midi = await navigator.requestMIDIAccess(/*{sysex:true}*/)
    let inputs = Array.from(midi.inputs.values())
    store.setState({inputs})
  } catch (e) {
    console.error("Failed to gain MIDI access.", e)
  }
}

run()
