import BasePlugin from './base/base-plugin'
import TimeoutPromise from '../../common/timeout-promise'
import * as NetworkIpc from '../../network/ipc'
import {GroupInfo, NetworkInfo, NodeFilterOptions} from '../../network/plugins/collateral-info'
import {MuonNodeInfo} from "../../common/types";
const log = require('../../common/muon-log')('muon:core:plugins:collateral')

export default class CollateralInfoPlugin extends BasePlugin{

  groupInfo: GroupInfo;
  networkInfo: NetworkInfo;
  private availablePeerIds: {[index: string]: boolean} = {}
  private allowedWallets: string[] = []

  private _nodesList: MuonNodeInfo[];
  private _nodesMap: Map<string, MuonNodeInfo> = new Map<string, MuonNodeInfo>();
  /**
   * @type {TimeoutPromise}
   */
  loading = new TimeoutPromise(0, "collateral loading timedout");

  async onStart(){
    super.onStart();

    this.muon.on('peer:discovery', this.onPeerDiscovery.bind(this));
    this.muon.on('peer:connect', this.onPeerConnect.bind(this));
    this.muon.on('peer:disconnect', this.onPeerDisconnect.bind(this));

    this.muon.on("node:add", this.onNodeAdd.bind(this));
    this.muon.on("node:edit", this.onNodeEdit.bind(this));
    this.muon.on("node:delete", this.onNodeDelete.bind(this));

    this._loadCollateralInfo();

    // // TODO: check more this change
    // this.muon.once('peer:connect', () => {
    //   console.log('first node connected ...')
    //   // Listen to contract events and inform any changes.
    //   // TODO: uncomment this. (commented for debug)
    //   // this._watchContractEvents();
    //
    //   this._loadCollateralInfo();
    // })
  }

  async onPeerDiscovery(peerId: string) {
    log(`peer discovered %s`, peerId)
    this.availablePeerIds[peerId] = true
    this.updateNodeInfo(peerId, {isOnline: true});
  }

  async onPeerConnect(peerId: string) {
    log(`peer connected %s`, peerId)
    this.availablePeerIds[peerId] = true
    this.updateNodeInfo(peerId, {isOnline: true});
  }

  onPeerDisconnect(peerId: string) {
    log(`peer disconnected %s`, peerId)
    delete this.availablePeerIds[peerId]
    this.updateNodeInfo(peerId, {isOnline: false});
  }

  private updateNodeInfo(index: string, dataToMerge: object, keysToDelete?:string[]) {
    let nodeInfo = this.getNodeInfo(index)!;
    if (nodeInfo) {
      /** update fields */
      if (dataToMerge) {
        Object.keys(dataToMerge).forEach(key => {
          nodeInfo[key] = dataToMerge[key];
        })
      }
      /** delete keys */
      if (keysToDelete) {
        keysToDelete.forEach(key => {
          delete nodeInfo[key]
        })
      }
      /**
       * all three indexes id|wallet|peerId contains same object reference.
       * by changing peerId index other two indexes, will change too.
       */
      this._nodesMap.set(index, nodeInfo);
    }
  }

  onNodeAdd(nodeInfo: MuonNodeInfo) {
    log(`Core.CollateralInfo.onNodeAdd %o`, nodeInfo)
    this.groupInfo.partners.push(nodeInfo.id);
    this._nodesList.push(nodeInfo)

    this._nodesMap
      .set(nodeInfo.id, nodeInfo)
      .set(nodeInfo.wallet, nodeInfo)
      .set(nodeInfo.peerId, nodeInfo)

    this.allowedWallets.push(nodeInfo.wallet);
  }

  onNodeEdit(data: {nodeInfo: MuonNodeInfo, oldNodeInfo: MuonNodeInfo}) {
    const {nodeInfo, oldNodeInfo} = data
    log(`Core.CollateralInfo.onNodeEdit %o`, {nodeInfo, oldNodeInfo})
    const listIndex = this._nodesList.findIndex(item => item.id === nodeInfo.id)
    this._nodesList.splice(listIndex, 1, nodeInfo);

    this._nodesMap
      .set(nodeInfo.id, nodeInfo)
      .set(nodeInfo.wallet, nodeInfo)
      .set(nodeInfo.peerId, nodeInfo)


    /** update allowedWallets */
    const idx2 = this.allowedWallets.findIndex(w => w === oldNodeInfo.wallet)
    this.allowedWallets.splice(idx2, 1);
    this.allowedWallets.push(nodeInfo.wallet);
  }

  onNodeDelete(nodeInfo: MuonNodeInfo) {
    log(`Core.CollateralInfo.onNodeDelete %o`, nodeInfo)

    /** remove from groupInfo*/
    let pIndex = this.groupInfo.partners.indexOf(nodeInfo.id)
    this.groupInfo.partners.splice(pIndex, 1);

    /** remove from nodesList */
    const idx1 = this._nodesList.findIndex(item => item.id === nodeInfo.id)
    this._nodesList.splice(idx1, 1);

    /** remove from nodesMap */
    this._nodesMap.delete(nodeInfo.id)
    this._nodesMap.delete(nodeInfo.wallet)
    this._nodesMap.delete(nodeInfo.peerId)

    /** remove from allowedWallets */
    const idx2 = this.allowedWallets.findIndex(w => w === nodeInfo.wallet)
    this.allowedWallets.splice(idx2, 1);
  }

  async _loadCollateralInfo(){
    let info;
    while(!info) {
      try {
        info = await NetworkIpc.getCollateralInfo({timeout: 1000});
      }catch (e) {
        log(`process[${process.pid}] collateral info loading failed %o`, e);
      }
    }
    const { groupInfo, networkInfo, nodesList } = info

    this.groupInfo = groupInfo;
    this.networkInfo = networkInfo;

    this._nodesList = nodesList;
    nodesList.forEach(n => {
      this._nodesMap
        .set(n.id, n)
        .set(n.wallet, n)
        .set(n.peerId, n)
      this.allowedWallets.push(n.wallet);
    })

    log('Collateral info loaded.');
    this.emit('loaded');
    this.loading.resolve(true);
  }

  // TODO: not implemented
  getAllowedWallets(){
    return this.allowedWallets;
  }

  getDeployerNodes(): MuonNodeInfo[] {
    return this._nodesList.filter(n => n.isDeployer)
  }

  /**
   * @param index {string} - id/wallet/peerId of node
   */
  getNodeInfo(index: string): MuonNodeInfo|undefined {
    return this._nodesMap.get(index);
  }

  get TssThreshold(): number{
    if(this.networkInfo)
      return this.networkInfo?.tssThreshold;
    else
      return Infinity;
  }

  get MinGroupSize(){
    return this.networkInfo?.minGroupSize;
  }

  get MaxGroupSize(){
    return this.networkInfo?.maxGroupSize;
  }

  waitToLoad(): Promise<any>{
    return this.loading.promise;
  }

  isLoaded(): boolean{
    return this.loading.isFulfilled;
  }

  filterNodes(options: NodeFilterOptions): MuonNodeInfo[] {
    let result: MuonNodeInfo[]
    if(options.list) {
      result = options.list.map(n => this._nodesMap.get(n)!)
        .filter(n => !!n)
    }
    else {
      result = this._nodesList
    }
    if(options.isDeployer)
      result = result.filter(n => n.isDeployer)
    if(options.isOnline)
      result = result.filter(n => {
        return n.isOnline
      })
    if(options.excludeSelf)
      result = result.filter(n => n.wallet !== process.env.SIGN_WALLET_ADDRESS)
    return result
  }
}
