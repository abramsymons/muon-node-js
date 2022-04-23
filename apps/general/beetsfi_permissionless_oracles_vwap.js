const { axios, toBaseUnit, soliditySha3, BN, multiCall, ethCall } = MuonAppUtils

const getTimestamp = () => Math.floor(Date.now() / 1000)

const POOLID_ABI = [
  {
    inputs: [],
    name: 'getPoolId',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function'
  }
]

const POOL_TOKENS_ABI = [
  {
    inputs: [{ internalType: 'bytes32', name: 'poolId', type: 'bytes32' }],
    name: 'getPoolTokens',
    outputs: [
      { internalType: 'contract IERC20[]', name: 'tokens', type: 'address[]' },
      { internalType: 'uint256[]', name: 'balances', type: 'uint256[]' },
      { internalType: 'uint256', name: 'lastChangeBlock', type: 'uint256' }
    ],
    stateMutability: 'view',
    type: 'function'
  }
]
const VAULT_CONTRACT = '0x20dd72ed959b6147912c2e529f0a0c651c33c9ce'
const PRICE_TOLERANCE = 0.05
const FANTOM_ID = 250
const SCALE = new BN('1000000000000000000')
const GRAPH_DEPLOYMENT_ID = 'QmedPFoUR8iCji2r4BRBjpLvaHyGag6c3irb4REF8cJVVE'
const GRAPH_URL =
  'https://api.thegraph.com/subgraphs/name/shayanshiravani/beetsfi'

async function getTokenTxs(poolId) {
  try {
    const currentTimestamp = getTimestamp()
    const last30Min = currentTimestamp - 1800
    const query = `
      {
        swaps(
          where: {
            poolId: "${poolId.toLowerCase()}"
            timestamp_gt: ${last30Min}
          }, 
          orderBy: timestamp, 
          orderDirection: desc
        ) {
          poolId
          from
          tokenIn {
            id
          }
          tokenOut {
            id
          }
          tokenAmountIn
          tokenAmountOut
        }
        _meta{
          deployment
        }
      }
    `
    let { data, status } = await axios.post(GRAPH_URL, {
      query: query
    })
    if (status == 200 && data.data?.hasOwnProperty('swaps')) {
      if (data.data._meta.deployment !== GRAPH_DEPLOYMENT_ID)
        throw { message: 'SUBGRAPH_IS_UPDATED' }
      return data.data.swaps
    }
  } catch (error) {
    console.log('Error happend in fetch query subgraph', error)
  }
}

async function tokenVWAP(token, poolId) {
  let { tokenPrice, sumVolume } = await poolVWAP(poolId, token)

  let price = new BN(SCALE)
  price = price.mul(tokenPrice).div(SCALE)

  return { price, sumVolume }
}

async function poolVWAP(poolId, token) {
  let tokenTxs = await getTokenTxs(poolId)
  let sumVolume = new BN('0')
  if (tokenTxs) {
    let sumWeightedPrice = new BN('0')
    for (let i = 0; i < tokenTxs.length; i++) {
      let swap = tokenTxs[i]
      let price = new BN('0')
      let volume = new BN('0')
      switch (token) {
        case swap.tokenIn.id:
          price = toBaseUnit(swap.tokenAmountOut, '18')
            .mul(SCALE)
            .div(toBaseUnit(swap.tokenAmountIn, '18'))
          volume = toBaseUnit(swap.tokenAmountIn, '18')
          break

        case swap.tokenOut.id:
          price = toBaseUnit(swap.tokenAmountIn, '18')
            .mul(SCALE)
            .div(toBaseUnit(swap.tokenAmountOut, '18'))
          volume = toBaseUnit(swap.tokenAmountOut, '18')
          break

        default:
          break
      }

      sumWeightedPrice = sumWeightedPrice.add(price.mul(volume))
      sumVolume = sumVolume.add(volume)
    }
    if (sumVolume > new BN('0')) {
      let tokenPrice = sumWeightedPrice.div(sumVolume)
      return { tokenPrice, sumVolume }
    }
  }
  return { tokenPrice: new BN('0'), sumVolume }
}

async function LPTokenPrice(token, pairs) {
  const poolId = await ethCall(token, 'getPoolId', [], POOLID_ABI, FANTOM_ID)
  // console.log(poolId)
  const poolTokens = await ethCall(
    VAULT_CONTRACT,
    'getPoolTokens',
    [poolId],
    POOL_TOKENS_ABI,
    FANTOM_ID
  )
  // TODO only for return sth
  return poolTokens.balances[0]
}

module.exports = {
  APP_NAME: 'beetsfi_permissionless_oracles_vwap',
  APP_ID: 19,

  onRequest: async function (request) {
    let {
      method,
      data: { params }
    } = request

    switch (method) {
      // case 'price':
      //   let { token, poolId, hashTimestamp } = params
      //   // if (typeof pairs === 'string' || pairs instanceof String) {
      //   //   pairs = pairs.split(',')
      //   // }
      //   let { price, sumVolume } = await tokenVWAP(token, poolId)
      //   return {
      //     token,
      //     tokenPrice: price.toString(),
      //     poolId,
      //     volume: sumVolume.toString(),
      //     ...(hashTimestamp ? { timestamp: request.data.timestamp } : {})
      //   }
      case 'lp_price': {
        let { token, pairs, hashTimestamp } = params
        // if (typeof pairs === 'string' || pairs instanceof String) {
        //   pairs = pairs.split(',').filter((x) => x)
        // }

        let tokenPrice = await LPTokenPrice(token, pairs)

        return {
          token: token,
          tokenPrice: tokenPrice,
          ...(hashTimestamp ? { timestamp: request.data.timestamp } : {})
        }
      }

      default:
        throw { message: `Unknown method ${params}` }
    }
  },

  isPriceToleranceOk: function (price, expectedPrice) {
    let priceDiff = Math.abs(price - expectedPrice)
    if (priceDiff / expectedPrice > PRICE_TOLERANCE) {
      return false
    }
    return true
  },

  hashRequestResult: function (request, result) {
    let {
      method,
      data: { params }
    } = request
    let { hashTimestamp } = params
    switch (method) {
      // case 'price': {
      //   if (
      //     !this.isPriceToleranceOk(
      //       result.tokenPrice,
      //       request.data.result.tokenPrice
      //     )
      //   ) {
      //     throw { message: 'Price threshold exceeded' }
      //   }
      //   let { token, poolId } = result

      //   return soliditySha3([
      //     { type: 'uint32', value: this.APP_ID },
      //     { type: 'address', value: token },
      //     { type: 'uint256', value: poolId },
      //     { type: 'uint256', value: request.data.result.tokenPrice },
      //     { type: 'uint256', value: request.data.result.volume },

      //     ...(hashTimestamp
      //       ? [{ type: 'uint256', value: request.data.timestamp }]
      //       : [])
      //   ])
      // }
      case 'lp_price': {
        if (
          !this.isPriceToleranceOk(
            result.tokenPrice,
            request.data.result.tokenPrice
          )
        ) {
          throw { message: 'Price threshold exceeded' }
        }
        let { token, tokenPrice, pairs0, pairs1 } = result

        return soliditySha3([
          { type: 'uint32', value: this.APP_ID },
          { type: 'address', value: token },
          { type: 'uint256', value: request.data.result.tokenPrice },
          ...(hashTimestamp
            ? [{ type: 'uint256', value: request.data.timestamp }]
            : [])
        ])
      }
      default:
        return null
    }
  }
}
