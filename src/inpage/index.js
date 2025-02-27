const { initializeProvider, shimWeb3 } = require('@ezDeFi/inpage-provider')
const ObjectMultiplex = require('@metamask/object-multiplex')
const pump = require('pump')
const MobilePortStream = require('./MobilePortStream')
const ReactNativePostMessageStream = require('./ReactNativePostMessageStream')

const INPAGE = 'ezdefi-inpage'
const CONTENT_SCRIPT = 'ezdefi-contentscript'
const PROVIDER = 'ezdefi-provider'

// Setup stream for content script communication
const ezDeFiStream = new ReactNativePostMessageStream({
  name: INPAGE,
  target: CONTENT_SCRIPT,
})

// Initialize provider object (window.ethereum)
initializeProvider({
  connectionStream: ezDeFiStream,
  shouldSendMetadata: false,
})

// Set content script post-setup function
Object.defineProperty(window, '_ezDeFiSetupProvider', {
  value: () => {
    setupProviderStreams()
    delete window._ezDeFiSetupProvider
  },
  configurable: true,
  enumerable: false,
  writable: false,
})

// Functions

/**
 * Setup function called from content script after the DOM is ready.
 */
function setupProviderStreams () {
  // the transport-specific streams for communication between inpage and background
  const pageStream = new ReactNativePostMessageStream({
    name: CONTENT_SCRIPT,
    target: INPAGE,
  })

  const appStream = new MobilePortStream({
    name: CONTENT_SCRIPT,
  })

  // create and connect channel muxes
  // so we can handle the channels individually
  const pageMux = new ObjectMultiplex()
  pageMux.setMaxListeners(25)
  const appMux = new ObjectMultiplex()
  appMux.setMaxListeners(25)

  pump(
    pageMux,
    pageStream,
    pageMux,
    (err) => logStreamDisconnectWarning('ezDeFi Inpage Multiplex', err),
  )
  pump(
    appMux,
    appStream,
    appMux,
    (err) => {
      logStreamDisconnectWarning('ezDeFi Background Multiplex', err)
      notifyProviderOfStreamFailure()
    },
  )

  // forward communication across inpage-background for these channels only
  forwardTrafficBetweenMuxes(PROVIDER, pageMux, appMux)

  // add web3 shim
  shimWeb3(window.ethereum)
}

/**
 * Set up two-way communication between muxes for a single, named channel.
 *
 * @param {string} channelName - The name of the channel.
 * @param {ObjectMultiplex} muxA - The first mux.
 * @param {ObjectMultiplex} muxB - The second mux.
 */
function forwardTrafficBetweenMuxes (channelName, muxA, muxB) {
  const channelA = muxA.createStream(channelName)
  const channelB = muxB.createStream(channelName)
  pump(
    channelA,
    channelB,
    channelA,
    (err) => logStreamDisconnectWarning(`ezDeFi muxed traffic for channel "${channelName}" failed.`, err),
  )
}

/**
 * Error handler for page to extension stream disconnections
 *
 * @param {string} remoteLabel - Remote stream name
 * @param {Error} err - Stream connection error
 */
function logStreamDisconnectWarning (remoteLabel, err) {
  let warningMsg = `ezDeFiContentscript - lost connection to ${remoteLabel}`
  if (err) {
    warningMsg += `\n${err.stack}`
  }
  console.warn(warningMsg)
  console.error(err)
}

/**
 * This function must ONLY be called in pump destruction/close callbacks.
 * Notifies the inpage context that streams have failed, via window.postMessage.
 * Relies on @ezDeFi/object-multiplex and post-message-stream implementation details.
 */
function notifyProviderOfStreamFailure () {
  window.postMessage(
    {
      target: INPAGE, // the post-message-stream "target"
      data: {
        // this object gets passed to object-multiplex
        name: PROVIDER, // the object-multiplex channel name
        data: {
          jsonrpc: '2.0',
          method: 'EZDEFI_STREAM_FAILURE',
        },
      },
    },
    window.location.origin,
  )
}
