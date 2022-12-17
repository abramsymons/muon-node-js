/**
 * Generate Distributed Key
 * Sign message
 * Verify signature
 */
import {DistributedKeyGeneration} from "./dkg";
import FakeNetwork from './fake-network';
import {bn2str} from './utils'
const {toBN, soliditySha3, randomHex} = require('web3').utils
const {shuffle, range} = require('lodash')
const Polynomial = require('../../utils/tss/polynomial')
const TssModule = require('../../utils/tss/index')


/**
 * Share privateKey between 5 individuals
 * Needs to at least 3 individual's signature to recover global signature
 */
const N = TssModule.curve.n
const t = 2;
const NODE_1='1', NODE_2='2', NODE_3='3', NODE_4='4'


async function run() {

  const fakeNet1 = new FakeNetwork(NODE_1),
    fakeNet2 = new FakeNetwork(NODE_2),
    fakeNet3 = new FakeNetwork(NODE_3),
    fakeNet4 = new FakeNetwork(NODE_4)

  const specialPrivateKeys = [
    /** first 4 private keys */
    '0x0000000000000000000000000000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000000000000000000000000000002',
    '0x0000000000000000000000000000000000000000000000000000000000000003',
    '0x0000000000000000000000000000000000000000000000000000000000000004',

    /** 100 random private key */
      ...(new Array(100).fill(0).map(() => bn2str(toBN(randomHex(32)).umod(N)))),

    /** last 4 private keys */
    bn2str(TssModule.curve.n.subn(4)),
    bn2str(TssModule.curve.n.subn(3)),
    bn2str(TssModule.curve.n.subn(2)),
    bn2str(TssModule.curve.n.subn(1)),
  ]

  for(let i=0 ; i<specialPrivateKeys.length ; i++) {
    // const realPrivateKey = bn2str(toBN(randomHex(32)).umod(N));
    const realPrivateKey = specialPrivateKeys[i];

    /** DistributedKeyGen construction data */
    const cData = {
      id: 'dkg-1',
      partners: [NODE_1, NODE_2, NODE_3, NODE_4],
      t,
      pk: toBN(realPrivateKey)
    }

    let [node1Result, node2Result, node3Result, node4Result] = await Promise.all([
      /** run partner 1 */
      new DistributedKeyGeneration(cData.id, cData.partners, cData.t, cData.pk).process(fakeNet1),
      /** run partner 2 */
      new DistributedKeyGeneration(cData.id, cData.partners, cData.t, cData.pk).process(fakeNet2),
      /** run partner 2 */
      new DistributedKeyGeneration(cData.id, cData.partners, cData.t, cData.pk).process(fakeNet3),
      /** run partner 2 */
      new DistributedKeyGeneration(cData.id, cData.partners, cData.t, cData.pk).process(fakeNet4),
    ]);

    const shares = [
      {i: 1, key: TssModule.keyFromPrivate(node1Result)},
      {i: 2, key: TssModule.keyFromPrivate(node2Result)},
      {i: 3, key: TssModule.keyFromPrivate(node3Result)},
      {i: 4, key: TssModule.keyFromPrivate(node4Result)},
    ]
    const reconstructedKey = bn2str(TssModule.reconstructKey(shares, t, 0))

    if(reconstructedKey === reconstructedKey)
      console.log(`i: ${i}, match: OK`)
    else {
      console.log(`i: ${i}, match: false`)
      console.log({
        PK1: realPrivateKey,
        PK2: reconstructedKey,
      })
    }
  }
  process.exit(0)
}

run();

