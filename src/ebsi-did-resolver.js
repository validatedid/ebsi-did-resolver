import HttpProvider from 'ethjs-provider-http'
import Eth from 'ethjs-query'
import abi from 'ethjs-abi'
import BN from 'bn.js'
import EthContract from 'ethjs-contract'
import DidRegistryContract from '../contracts/ebsi-did-registry.json'
import { Buffer } from 'buffer'
import networksJson from './networks.json'
const REGISTRY = '0x2E1f232a9439C3D459FcEca0BeEf13acc8259Dd8'

function bytes32toString (bytes32) {
  return Buffer.from(bytes32.slice(2), 'hex')
    .toString('utf8')
    .replace(/\0+$/, '')
}

function stringToBytes32 (str) {
  const buffstr =
    '0x' +
    Buffer.from(str)
      .slice(0, 32)
      .toString('hex')
  return buffstr + '0'.repeat(66 - buffstr.length)
}

const delegateTypes = {
  Secp256k1SignatureAuthentication2018: stringToBytes32('sigAuth'),
  Secp256k1VerificationKey2018: stringToBytes32('veriKey')
}

const attrTypes = {
  sigAuth: 'SignatureAuthentication2018',
  veriKey: 'VerificationKey2018'
}

function wrapDidDocument (did, owner, history) {
  const now = new BN(Math.floor(new Date().getTime() / 1000))
  // const expired = {}
  const publicKey = [
    {
      id: `${did}#key-1`,
      type: 'Secp256k1VerificationKey2018',
      controller: did,
      ethereumAddress: owner
    }
  ]

  const authentication = [
    `${did}#key-1`
  ]

  let delegateCount = 0
  let keyCount = 1
  const auth = {}
  const pks = {}
  const services = {}
  for (const event of history) {
    // console.log(event)
    const validTo = event.validTo
    const key = `${event._eventName}-${event.delegateType ||
      event.name}-${event.delegate || event.value}`
    if (validTo && validTo.gte(now)) {
      if (event._eventName === 'DIDDelegateChanged') {
        delegateCount++
        const delegateType = bytes32toString(event.delegateType)
        switch (delegateType) {
          case 'sigAuth':
            auth[key] = `${did}#delegate-${delegateCount}`
          // eslint-disable-line no-fallthrough
          case 'veriKey':
            pks[key] = {
              id: `${did}#delegate-${delegateCount}`,
              type: 'Secp256k1VerificationKey2018',
              controller: did,
              ethereumAddress: event.delegate
            }
            break
        }
      } else if (event._eventName === 'DIDAttributeChanged') {
        const name = bytes32toString(event.name)
        const match = name.match(
          /^did\/(pub|auth|svc)\/(\w+)(\/(\w+))?(\/(\w+))?$/
        )
        if (match) {
          const section = match[1]
          const algo = match[2]
          const type = attrTypes[match[4]] || match[4]
          const encoding = match[6]
          switch (section) {
            case 'pub':
              keyCount++
              const pk = {
                id: `${did}#key-${keyCount}`,
                type: `${algo}${type}`,
                controller: did
              }
              switch (encoding) {
                case null:
                case undefined:
                case 'hex':
                  pk.publicKeyHex = event.value.slice(2)
                  break
                case 'base64':
                  pk.publicKeyBase64 = Buffer.from(event.value.slice(2), 'hex').toString('base64')
                  break
                case 'base58':
                  pk.publicKeyBase58 = Buffer.from(event.value.slice(2), 'hex').toString('base58')
                  break
                case 'pem':
                  pk.publicKeyPem = Buffer.from(event.value.slice(2), 'hex').toString()
                  break
                default:
                  pk.value = event.value
              }
              pks[key] = pk
              break
            case 'svc':
              services[key] = {
                type: algo,
                serviceEndpoint: Buffer.from(
                  event.value.slice(2),
                  'hex'
                ).toString()
              }
              break
          }
        }
      }
    } else {
      if (
        delegateCount > 0 &&
        event._eventName === 'DIDDelegateChanged' &&
        validTo.lt(now)
      ) { delegateCount-- }
      if (
        keyCount > 1 &&
        (event._eventName === 'DIDAttributeChanged' &&
            bytes32toString(event.name).match(/^did\/pub\//)) &&
        validTo.lt(now)
      ) { keyCount-- }
      delete auth[key]
      delete pks[key]
      delete services[key]
    }
  }

  const doc = {
    '@context': 'https://w3id.org/did/v1',
    id: did,
    publicKey: publicKey.concat(Object.values(pks)),
    authentication: authentication.concat(Object.values(auth))
  }
  if (Object.values(services).length > 0) {
    doc.service = Object.values(services)
  }

  return doc
}

function configureProvider (conf = {}) {
  if (conf.provider) {
    return conf.provider
  } else if (conf.web3) {
    return conf.web3.currentProvider
  } else {
    return new HttpProvider(conf.rpcUrl || 'https://api.ebsi.tech.ec.europa.eu/blockchain/besu')
  }
}

function configureNetwork (conf = {}) {
  const provider = configureProvider(conf)
  const eth = new Eth(provider)
  const registryAddress = conf.registry || REGISTRY
  const DidReg = new EthContract(eth)(DidRegistryContract.abi)
  const didReg = DidReg.at(registryAddress)

  return { eth, registryAddress, didReg }
}

function configureNetworks (networksConf = []) {
  const networks = {}
  for (let i = 0; i < networksConf.length; i++) {
    const net = networksConf[i]
    networks[net.name] = configureNetwork(net)
  }
  return networks
}

function getResolver (conf = {}) {
  const logDecoder = abi.logDecoder(DidRegistryContract.abi, false)

  const networks = {
    ebsi: configureNetwork(conf),
    ...configureNetworks(networksJson),
    ...configureNetworks(conf.networks)
  }

  const lastChanged = async (identity, networkId) => {
    const result = await networks[networkId].didReg.changed(identity)
    if (result) {
      return result['0']
    }
  }
  async function changeLog (identity, networkId) {
    const history = []
    let owner = identity
    let previousChange = await lastChanged(identity, networkId)
    if (previousChange) {
      const ownerRecord = await networks[networkId].didReg.identityOwner(identity)
      owner = ownerRecord['0']
    }
    while (previousChange) {
      const blockNumber = previousChange
      const logs = await networks[networkId].eth.getLogs({
        address: networks[networkId].registryAddress,
        topics: [null, `0x000000000000000000000000${identity.slice(2)}`],
        fromBlock: previousChange,
        toBlock: previousChange
      })
      const events = logDecoder(logs)
      previousChange = undefined
      for (const event of events) {
        history.unshift(event)
        if (event.previousChange.lt(blockNumber)) {
          previousChange = event.previousChange
        }
      }
    }
    return { owner, history }
  }
  async function resolve (did, parsed) {
    const fullId = parsed.id.match(/^(.*)?(0x[0-9a-fA-F]{40})$/)
    if (!fullId) throw new Error(`Not a valid ebsi DID: ${did}`)
    const id = fullId[2]
    const networkId = (!fullId[1]) ? 'ebsi' : fullId[1].slice(0, -1)

    if (!networks[networkId]) throw new Error(`No conf for networkId: ${networkId}`)

    const { owner, history } = await changeLog(id, networkId)
    return wrapDidDocument(did, owner, history)
  }

  return { ebsi: resolve }
}

module.exports = {
  REGISTRY,
  bytes32toString,
  stringToBytes32,
  delegateTypes,
  attrTypes,
  wrapDidDocument,
  getResolver
}