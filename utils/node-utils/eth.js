const Web3 = require('web3')
const EventEmbitter = require('events')
const HttpProvider = Web3.providers.HttpProvider
const WebsocketProvider = Web3.providers.WebsocketProvider
const CID = require('cids')
const multihashing = require('multihashing-async')
const { flattenObject, sortObject, getTimestamp } = require('../helpers')
const crypto = require('../crypto')
const ERC20_ABI = require('../../data/ERC20-ABI')
const ERC721_ABI = require('../../data/ERC721-ABI')
const {
  nameToChainIdMap,
  getBaseChain
} = require('../constants')

const _generalWeb3Instance = new Web3()
const soliditySha3 = _generalWeb3Instance.utils.soliditySha3

const _networksWeb3 = {
  ganache: new Web3(new HttpProvider(process.env.WEB3_PROVIDER_GANACHE)),
  // ethereum mani net
  1: new Web3(new HttpProvider(process.env.WEB3_PROVIDER_ETH)),
  3: new Web3(new HttpProvider(process.env.WEB3_PROVIDER_ROPSTEN)),
  4: new Web3(new HttpProvider(process.env.WEB3_PROVIDER_RINKEBY)),
  56: new Web3(new HttpProvider(process.env.WEB3_PROVIDER_BSC)),
  97: new Web3(new HttpProvider(process.env.WEB3_PROVIDER_BSCTEST)),
  250: new Web3(new HttpProvider(process.env.WEB3_PROVIDER_FTM)),
  4002: new Web3(new HttpProvider(process.env.WEB3_PROVIDER_FTMTEST)),
  100: new Web3(new HttpProvider('https://rpc.xdaichain.com/')),
  77: new Web3(new HttpProvider('https://sokol.poa.network')),
  137: new Web3(new HttpProvider('https://polygon-rpc.com/')),
  80001: new Web3(new HttpProvider('https://rpc-mumbai.maticvigil.com/')),
  43113: new Web3(
    new HttpProvider('https://api.avax-test.network/ext/bc/C/rpc')
  ),
  43114: new Web3(new HttpProvider('https://api.avax.network/ext/bc/C/rpc')),
  421611: new Web3(new HttpProvider('https://rinkeby.arbitrum.io/rpc')),
  42161: new Web3(new HttpProvider('https://arb1.arbitrum.io/rpc')),
  1088: new Web3(new HttpProvider(' https://andromeda.metis.io/?owner=1088'))
}

function getWeb3(network) {
  if (_networksWeb3[network]) return Promise.resolve(_networksWeb3[network])
  else if (_networksWeb3[nameToChainIdMap[network]])
    return Promise.resolve(_networksWeb3[nameToChainIdMap[network]])
  else return Promise.reject({ message: `invalid network "${network}"` })
}

function getWeb3Sync(network) {
  if (_networksWeb3[network]) return _networksWeb3[network]
  else if (_networksWeb3[nameToChainIdMap[network]])
    return _networksWeb3[nameToChainIdMap[network]]
  else throw { message: `invalid network "${network}"` }
}

function hashCallOutput(
  address,
  method,
  abi,
  result,
  outputFilter = [],
  extraParams = []
) {
  let methodAbi = abi.find(
    ({ name, type }) => name === method && type === 'function'
  )
  if (!methodAbi) {
    throw { message: `Abi of method (${method}) not found` }
  }
  let abiOutputs = methodAbi.outputs
  if (!!outputFilter && outputFilter.length > 0) {
    abiOutputs = outputFilter.map((key) => {
      return methodAbi.outputs.find(({ name }) => name === key)
    })
  }
  // console.log('signing:',abiOutputs)
  let params = abiOutputs.map(({ name, type }) => ({
    type,
    value: !name || typeof result === 'string' ? result : result[name]
  }))
  params = [{ type: 'address', value: address }, ...params, ...extraParams]
  let hash = _generalWeb3Instance.utils.soliditySha3(...params)
  return hash
}

function getTokenInfo(address, network) {
  return getWeb3(network).then(async (web3) => {
    let contract = new web3.eth.Contract(ERC20_ABI, address)
    return {
      symbol: await contract.methods.symbol().call(),
      name: await contract.methods.name().call(),
      decimals: await contract.methods.decimals().call()
    }
  })
}
function getNftInfo(address, network) {
  return getWeb3(network).then(async (web3) => {
    let contract = new web3.eth.Contract(ERC721_ABI, address)
    return {
      symbol: await contract.methods.symbol().call(),
      name: await contract.methods.name().call()
    }
  })
}

function getTransaction(txHash, network) {
  return getWeb3(network).then((web3) => web3.eth.getTransaction(txHash))
}

function getTransactionReceipt(txHash, network) {
  return getWeb3(network).then((web3) => web3.eth.getTransactionReceipt(txHash))
}

function call(contractAddress, methodName, params, abi, network) {
  return getWeb3(network).then((web3) => {
    let contract = new web3.eth.Contract(abi, contractAddress)
    return contract.methods[methodName](...params).call()
  })
}

function read(contractAddress, property, params, abi, network) {
  return getWeb3(network).then((web3) => {
    let contract = new web3.eth.Contract(abi, contractAddress)
    return contract.methods[property].call(...params)
  })
}

function isEqualObject(obj1, obj2) {
  return objectToStr(obj1) === objectToStr(obj2)
}

function isEqualResult(request, result) {
  switch (request.method) {
    case 'call': {
      let { address, method, abi, outputs } = request.data.callInfo
      let hash1 = hashCallOutput(
        address,
        method,
        abi,
        request.data.result,
        outputs
      )
      let hash2 = hashCallOutput(address, method, abi, result, outputs)
      return hash1 == hash2
    }
    case 'addBridgeToken': {
      let { token: t1, tokenId: id1 } = request.data.result
      let { token: t2, tokenId: id2 } = result
      let hash1 = soliditySha3([
        { type: 'uint256', value: id1 },
        { type: 'string', value: t1.name },
        { type: 'string', value: t1.symbol },
        { type: 'uint8', value: t1.decimals }
      ])
      let hash2 = soliditySha3([
        { type: 'uint256', value: id2 },
        { type: 'string', value: t2.name },
        { type: 'string', value: t2.symbol },
        { type: 'uint8', value: t2.decimals }
      ])
      return hash1 == hash2
    }
  }
}

function objectToStr(obj) {
  let flatData = flattenObject(obj)
  flatData = sortObject(flatData)
  return JSON.stringify(flatData)
}

async function signRequest(request, result) {
  let signature = null
  let signTimestamp = getTimestamp()

  switch (request.method) {
    case 'call': {
      let { abi, address, method, outputs } = request.data.callInfo
      signature = crypto.signCallOutput(address, method, abi, result, outputs)
      break
    }
    case 'addBridgeToken': {
      let { token, tokenId } = result
      let dataToSign = [
        { type: 'uint256', value: tokenId },
        { type: 'string', value: token.name },
        { type: 'string', value: token.symbol },
        { type: 'uint8', value: token.decimals }
      ]
      signature = crypto.sign(soliditySha3(dataToSign))
      break
    }
    default:
      throw { message: `Unknown eth app method: ${request.method}` }
  }

  return {
    request: request._id,
    owner: process.env.SIGN_WALLET_ADDRESS,
    timestamp: signTimestamp,
    data: result,
    signature
  }
}

function recoverSignature(request, sign) {
  let signer = null
  let { data: result, signature } = sign
  switch (request.method) {
    case 'call': {
      let { address, method, abi, outputs } = request.data.callInfo
      signer = crypto.recoverCallOutputSignature(
        address,
        method,
        abi,
        result,
        outputs,
        signature
      )
      break
    }
    case 'addBridgeToken': {
      let { token, tokenId } = result
      let dataToSign = [
        { type: 'uint256', value: tokenId },
        { type: 'string', value: token.name },
        { type: 'string', value: token.symbol },
        { type: 'uint8', value: token.decimals }
      ]
      signer = crypto.recover(soliditySha3(dataToSign), signature)
      break
    }
    default:
      throw { message: `Unknown eth app method: ${request.method}` }
  }

  return signer
}

async function createCID(request) {
  const bytes = new TextEncoder('utf8').encode(JSON.stringify(request))

  const hash = await multihashing(bytes, 'sha2-256')
  const cid = new CID(0, 'dag-pb', hash)
  return cid.toString()
}

const subscribeLogEvent = (
  network,
  contractAddress,
  contractAbi,
  eventName,
  interval = 5000
) => {
  let subscribe = new Subscribe(
    network,
    contractAddress,
    contractAbi,
    eventName,
    interval
  )
  return subscribe
}

class Subscribe extends EventEmbitter {
  constructor(network, contractAddress, abi, eventName, interval = 15000) {
    super()
    let web3 = getWeb3Sync(network)
    let contract = new web3.eth.Contract(abi, contractAddress)

    this.web3 = web3
    this.network = network
    this.interval = interval
    this.contract = contract
    this.lastBlock = -1
    this.eventName = eventName
    this._handler = this._handler.bind(this)

    this.timeout = setTimeout(this._handler, interval)
  }

  async _handler() {
    if (this.lastBlock < 0) {
      let lastBlock = (await this.web3.eth.getBlockNumber()) - 9000
      console.log(
        `watch ${this.network}:${this.contract._address} (${this.eventName}) from block ${lastBlock}`
      )
      this.lastBlock = lastBlock
    }

    let { contract, eventName, lastBlock, network } = this
    contract.getPastEvents(
      eventName,
      {
        // filter: {id: id},
        fromBlock: lastBlock,
        toBlock: 'latest'
      },
      (error, result) => {
        if (!error) {
          let txs = []
          if (result.length > 0) {
            let lastBlock = Math.max(
              ...result.map(({ blockNumber }) => blockNumber)
            )
            this.lastBlock = lastBlock + 1
            txs = result.map(
              ({ transactionHash, returnValues, blockNumber }) => ({
                blockNumber,
                transactionHash,
                returnValues
              })
            )
            this.emit('event', txs, network, contract._address)
          }
        } else {
          this.emit('error', error, network, contract._address)
        }
      }
    )
    setTimeout(this._handler, this.interval)
  }
}

module.exports = {
  getWeb3,
  getWeb3Sync,
  hashCallOutput,
  soliditySha3,
  getTransaction,
  getTransactionReceipt,
  call,
  read,
  isEqualObject,
  isEqualResult,
  signRequest,
  recoverSignature,
  createCID,
  subscribeLogEvent,
  getTokenInfo,
  getNftInfo
}
