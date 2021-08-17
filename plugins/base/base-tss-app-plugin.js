const BaseAppPlugin = require('./base-app-plugin')
const { getTimestamp, timeout } = require('../../utils/helpers')
const Signature = require('../../gateway/models/Signature')
const tss = require('../../utils/tss');
const {toBN} = require('../../utils/tss/utils')
const Point = require('../../utils/tss/point')


class BaseTssAppPlugin extends BaseAppPlugin {

  async onStart() {
    super.onStart()

    let remoteCall = this.muon.getPlugin('remote-call')
    remoteCall.on(
      `remote:app-${this.APP_NAME}-wantSign`,
      this.__onRemoteWantSign.bind(this)
    )
  }

  broadcastNewRequest(request) {
    let tssPlugin = this.muon.getPlugin('__tss-plugin__');
    let {data: {init: {party: partyId, nonce: nonceId}}} = request;
    let party = tssPlugin.getParty(partyId)
    let nonce = tssPlugin.getSharedKey(nonceId)

    Object.values(party.partners)
      .filter(({wallet}) => wallet!==process.env.SIGN_WALLET_ADDRESS)
      .map(async ({peer}) => {
        this.remoteCall(peer, 'wantSign', request).then(
          this.__onRemoteSignRequest.bind(this)
        )
      })
  }

  makeSignature(request, result, resultHash) {
    let t0 = Date.now()
    let signTimestamp = getTimestamp()
    // let signature = crypto.sign(resultHash)

    let tssPlugin = this.muon.getPlugin('__tss-plugin__');
    let {data: {init: {party: partyId, nonce: nonceId}}} = request;
    let party = tssPlugin.getParty(partyId)
    let nonce = tssPlugin.getSharedKey(nonceId)

    let k_i = nonce.getTotalFH().f
    let K = nonce.getTotalPubKey();
    let signature = tss.schnorrSign(process.env.SIGN_WALLET_PRIVATE_KEY, k_i, K, resultHash)
    console.log('base-tss-app-plugin.makeSignature', {time: Date.now() - t0})
    return {
      request: request._id,
      owner: process.env.SIGN_WALLET_ADDRESS,
      pubKey: tss.key2pub(process.env.SIGN_WALLET_PRIVATE_KEY).serialize(),
      timestamp: signTimestamp,
      data: result,
      signature:`0x${signature.s.toString(16)},0x${signature.e.toString(16)}`
    }
  }

  recoverSignature(request, sign) {
    // TODO: recovery not implemented

    let {owner, pubKey} = sign;
    pubKey = Point.deserialize(pubKey);
    if(owner !== tss.pub2addr(pubKey)) {
      console.log({
        owner,
        pubKey: pubKey.serialize(),
      })
      throw {message: 'Sign recovery error: invalid pubKey address'}
    }

    let [s, e] = sign.signature.split(',').map(toBN)
    // let sig = {s, e}
    //
    let tssPlugin = this.muon.getPlugin('__tss-plugin__');
    let {data: {init: {nonce: nonceId}}} = request;
    let nonce = tssPlugin.getSharedKey(nonceId)
    //
    let idx = this.muon.getNodesWalletIndex()[sign.owner];
    let Z_i = pubKey;
    let K_i = nonce.getPubKey(idx);

    let p1 = tss.pointAdd(K_i, tss.scalarMult(e.neg(), Z_i))
    let p2 = tss.scalarMult(s, tss.curve.g);
    // console.log([p1.serialize(), p2.serialize()])
    return p1.serialize() === p2.serialize() ? sign.owner : null;
  }

  async isOtherNodesConfirmed(newRequest) {
    let startTime = Date.now()
    let confirmed = false
    let allSignatures = []
    let signers = {}

    let {party: partyId, nonce: nonceId} = newRequest.data.init;
    let party = this.getTssPlugin().getParty(partyId);
    let nonce = this.getTssPlugin().getSharedKey(nonceId);
    let K = nonce.getTotalPubKey();
    let tssSign = null
    let masterWalletPubKey = this.muon.getSharedWalletPubKey()
    let signersIndices;

    while (!confirmed && (Date.now() - startTime) < 15000) {
      await timeout(250)
      let t0 = Date.now()
      allSignatures = await Signature.find({ request: newRequest._id })
      signers = {}

      // make signatures unique
      for (let sig of allSignatures) {
        signers[sig.owner] = sig
      }

      if (Object.keys(signers).length >= party.t) {
        let owners = Object.keys(signers)
        allSignatures = owners.map(w => signers[w]);

        let schnorrSigns = allSignatures.map(({signature}) => {
          let [s, e] = signature.split(',').map(toBN)
          return {s, e};
        })
        signersIndices = owners.map(w => this.muon.getNodesWalletIndex()[w])
        tssSign = tss.schnorrAggregateSigs(party.t, schnorrSigns, signersIndices)
        let resultHash = this.hashRequestResult(newRequest, newRequest.data.result);

        // TODO: check more combination of signatures. some time one combination not verified bot other combination does.
        confirmed = tss.schnorrVerify(masterWalletPubKey, resultHash, tssSign)
        break;
      }
      console.log('base-tss-app-plugin.isOtherNodeConfirmed iteration time', {time: Date.now()-t0})
    }

    return [
      confirmed,
      confirmed ? [{
          owner: tss.pub2addr(masterWalletPubKey),
          signers: signersIndices,
          timestamp: getTimestamp(),
          result: newRequest.data.result,
          signature: `0x${tssSign.s.toString(16)},0x${tssSign.e.toString(16)}`,
          memWriteSignature: allSignatures[0]['memWriteSignature']
      }] : []
    ]
  }

  getTssPlugin(){
    return this.muon.getPlugin('__tss-plugin__');
  }

  async __onRemoteWantSign(request) {
    console.log(`__onRemoteWantSign at ${parseInt(Date.now() / 1000)}`)
    let [sign, memWrite] = await this.processRemoteRequest(request)
    // console.log('wantSign', request._id, sign)
    return { sign, memWrite }
  }
}

module.exports = BaseTssAppPlugin
