const BasePlugin = require('../base/base-plugin')
const uint8ArrayFromString = require('uint8arrays/from-string')
const uint8ArrayToString = require('uint8arrays/to-string')
const Party = require('./party')
const DKey = require('./distributed-key')
const tss = require('../../utils/tss')

const MSG_TYPE_JOIN_PARTY_REQ = 'join_party_request'
const MSG_TYPE_JOIN_PARTY_RES = 'join_party_response'

const RemoteMethods = {
  joinToParty: 'joinToParty',
  setPartners: 'setPartners',
  distributeKey: 'distributeKey',
  distributePubKey: 'distributePubKey',
}

class TssPlugin extends BasePlugin {

  parties = {}
  keys = {}

  constructor(...params){
    super(...params)
  }

  async onStart(){
    let broadcastChannel = this.getBroadcastChannel()
    await this.muon.libp2p.pubsub.subscribe(broadcastChannel)
    this.muon.libp2p.pubsub.on(broadcastChannel, this.__onBroadcastReceived.bind(this))

    this.registerRemoteMethod(RemoteMethods.joinToParty, this.__joinToParty)
    this.registerRemoteMethod(RemoteMethods.setPartners, this.__setPartners)
    this.registerRemoteMethod(RemoteMethods.distributeKey, this.__distributeKey)
    this.registerRemoteMethod(RemoteMethods.distributePubKey, this.__distributePubKey)
  }

  getBroadcastChannel() {
    return `muon/tss/comm/broadcast`;
  }

  /**
   * This makes a group of nodes that will works together in order to make Key/Signature.
   * @param t: number of nodes needed to reconstruct shared key.
   * @returns {Promise<TssParty|null>}
   */
  async makeParty(t=2){
    // let party = await this._makeNewParty(2);
    // const peers = await this.getPartyPeers(party)
    // party.setPeers(peers)
    // await this.initParty(party)
    try {

      let party = new Party(t);
      this.parties[party.id] = party;
      let partyStartTime = Date.now()

      this.broadcast({
        type: MSG_TYPE_JOIN_PARTY_REQ,
        id: party.id,
        peerId: process.env.PEER_ID,
        wallet: process.env.SIGN_WALLET_ADDRESS,
      })

      let partyFullFilled = new Promise((resolve, reject) => {
        let check = () => {
          if (Object.keys(party.partners).length >= t)
            return resolve(party)
          if (Date.now() - partyStartTime > 5000)
            return resolve(null)
          setTimeout(check, 500);
        }
        setTimeout(check, 50)
      })

      await partyFullFilled;

      // let partners = Object.values(party.partners).filter(({peerId}) => peerId != process.env.PEER_ID)
      // let peers = await Promise.all(partners.map(({peerId}) => this.findPeer(peerId)))
      let peers = await this.getPartyPeers(party);
      party.setPeers(peers);

      await this.remoteCall(
        peers,
        RemoteMethods.setPartners,
        {
          id: party.id,
          t: party.t,
          partners: party.partners,
        }
      )

      return party;
    }
    catch (e) {
      console.error(e);
      return null;
    }
  }

  async keyGen(party){
    // 1- create new key
    let key = new DKey(party)
    this.keys[key.id] = key;
    // 2- distribute key initialization
    await this.broadcastKey(key)
    // 4- calculate distributed key part
    let sharedKey = await key.getSharedKey()
    return {
      id: key.id,
      keyPart: sharedKey.f,
      key: "shared",
      pubKey: key.getTotalPubKey(),
      address: tss.pub2addr(key.getTotalPubKey())
    }
  }

  async broadcastKey(key){
    let walletIndexes = this.muon.getNodesWalletIndex();
    let {party} = key;

    // set key self FH
    let selfWalletIndex = walletIndexes[process.env.SIGN_WALLET_ADDRESS]
    let selfFH = key.getFH(selfWalletIndex)
    key.setFH(selfWalletIndex, selfFH.f, selfFH.h);

    await Promise.all(Object.values(party.partners).map(({wallet, peerId, peer}) => {
      if(wallet === process.env.SIGN_WALLET_ADDRESS)
        return Promise.resolve(true);

      let walletIndex = walletIndexes[wallet]
      return this.remoteCall(
        peer,
        RemoteMethods.distributeKey,
        {
          from: process.env.SIGN_WALLET_ADDRESS,
          party: party.id,
          key: key.id,
          walletIndex,
          ... key.getFH(walletIndex),
        }
      )
    }))
  }

  async broadcastPubKey(key){
    // check either already distributed or not
    if(key.pubKeyDistributed)
      return;

    key.pubKeyDistributed = true;

    // Public key of f polynomial coefficients.
    let A_ik = key.f_x.coefficients.map(a_k => tss.key2pub(a_k).serialize())
    // console.log({A_ik})
    let fromIndex = this.muon.getNodesWalletIndex()[process.env.SIGN_WALLET_ADDRESS]
    key.setParticipantPubKeys(fromIndex, A_ik)

    let {party} = key;
    await Promise.all(Object.values(party.partners).map(({wallet, peerId, peer}) => {
      if(wallet === process.env.SIGN_WALLET_ADDRESS)
        return Promise.resolve(true);

      return this.remoteCall(
        peer,
        RemoteMethods.distributePubKey,
        {
          from: process.env.SIGN_WALLET_ADDRESS,
          party: party.id,
          key: key.id,
          pubKeys: A_ik
        }
      )
    }))
  }

  getPartyPeers(party){
    let partners = Object.values(party.partners).filter(({peerId}) => peerId!=process.env.PEER_ID)
    let peerIds = partners.map(({peerId}) => peerId)
    return Promise.all(peerIds.map(peerId => this.findPeer(peerId)))
  }

  getParty(id){
    return this.parties[id];
  }

  getSharedKey(id){
    return this.keys[id];
  }

  async hash(msg, party){
  }

  async sign(hash, party, nonce){
    console.log({
      ...nonce,
      keyPart: nonce.keyPart.toString(),
      pubKey: {
        x: nonce.pubKey.x.toString(),
        y: nonce.pubKey.y.toString(),
      }
    })
  }

  async verify(hash, sign){
  }

  async handleBroadcastMessage(msg){
    // console.log(msg);
    switch (msg.type) {
      case MSG_TYPE_JOIN_PARTY_REQ: {
        let peer = await this.findPeer(msg.peerId)
        await this.remoteCall(
          peer,
          RemoteMethods.joinToParty,
          {
            id: msg.id,
            peerId: process.env.PEER_ID,
            wallet: process.env.SIGN_WALLET_ADDRESS
          }
        )
        break
      }
      default:
        console.log(`unknown message`, msg);
    }
  }

  async __onBroadcastReceived(msg) {
    try {
      let data = JSON.parse(uint8ArrayToString(msg.data));
      this.handleBroadcastMessage(data)
    } catch (e) {
      console.error(e)
    }
  }

  broadcast(data) {
    let broadcastChannel = this.getBroadcastChannel()
    if (!broadcastChannel)
      return;
    let str = JSON.stringify(data)
    this.muon.libp2p.pubsub.publish(broadcastChannel, uint8ArrayFromString(str))
  }

  remoteCall(peer, methodName, data){
    let remoteCall = this.muon.getPlugin('remote-call')
    let remoteMethodEndpoint = this.remoteMethodEndpoint(methodName)
    if(Array.isArray(peer)){
      return Promise.all(peer.map(p => remoteCall.call(p, remoteMethodEndpoint, data)))
    }
    else{
      return remoteCall.call(peer, remoteMethodEndpoint, data)
    }
  }

  registerRemoteMethod(title, method){
    let remoteCall = this.muon.getPlugin('remote-call')
    remoteCall.on(`remote:${this.remoteMethodEndpoint(title)}`, method.bind(this))
  }

  remoteMethodEndpoint(title) {
    return `tss-${title}`
  }

  /**==================================
   *
   *           Remote Methods
   *
   *===================================*/

  async __joinToParty(data={}){
    // console.log('__joinToParty', data)
    let {id, peerId, wallet} = data
    this.parties[id].addPartner({peerId, wallet})
  }

  async __setPartners(data={}){
    // console.log('__setPartners', data)
    let {id, t, partners} = data;
    if(!this.parties[id])
      this.parties[id] = new Party(t, id)
    Object.values(partners).map(p => {
      this.parties[id].addPartner(p)
    })
    let peers = await this.getPartyPeers(this.parties[id])
    this.parties[id].setPeers(peers)
    console.log('__setPartners: partner length is ', this.parties[id].size())
    // return 1
    // let {id} = data
    // this.parties[id].addPartner(data)
  }

  async __distributeKey(data={}){
    // console.log('__distributeKey', data)
    let {parties, keys} = this
    let {from, party, key, f, h} = data
    if(!parties[party]) {
      throw {message: 'party not found'}
    }
    if(!keys[key]){
      keys[key] = new DKey(parties[party], key)
      this.broadcastKey(keys[key])
    }
    let fromIndex = this.muon.getNodesWalletIndex()[from]
    keys[key].setFH(fromIndex, f, h)

    if(keys[key].isKeyDistributed()){
      this.broadcastPubKey(keys[key])
    }
  }

  async __distributePubKey(data={}){
    // console.log('__distributePubKey', data)
    let {parties, keys} = this
    let {from, party, key, pubKeys} = data
    if(!parties[party]) {
      throw {message: 'party not found'}
    }
    if(!keys[key]){
      throw {message: 'distributed key not found'}
    }
    let fromIndex = this.muon.getNodesWalletIndex()[from]
    keys[key].setParticipantPubKeys(fromIndex, pubKeys)
  }
}

module.exports = TssPlugin;
