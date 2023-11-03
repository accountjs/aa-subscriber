import { BigNumber, BigNumberish } from 'ethers'
import { getAddr } from './moduleUtils'
import { requireCond } from '../utils'
import { ReputationManager } from './ReputationManager'
import Debug from 'debug'
import { ReferencedCodeHashes, StakeInfo, UserOperation, ValidationErrors } from './Types'
import fs from 'fs'

const debug = Debug('aa.mempool')

export interface MempoolEntry {
  userOp: UserOperation
  userOpHash: string
  prefund: BigNumberish
  referencedContracts: ReferencedCodeHashes
  // aggregator, if one was found during simulation
  aggregator?: string
  activeFlag?: boolean
}

type MempoolDump = UserOperation[]

const MAX_MEMPOOL_USEROPS_PER_SENDER = 4

export class MempoolManager {
  private mempool: MempoolEntry[] = []

  // count entities in mempool.
  private entryCount: { [addr: string]: number | undefined } = {}

  constructor (
    readonly reputationManager: ReputationManager) {
    fs.exists('./mempool.json', (exists) => {
      if (!exists) {
        fs.writeFileSync('./mempool.json', JSON.stringify([]))
      }
      this.mempool = JSON.parse(fs.readFileSync('./mempool.json').toString())
    })
  }

  count (): number {
    return this.mempool.filter((mempoolEntry) => !(mempoolEntry.activeFlag === false)).length
  }

  // add userOp into the mempool, after initial validation.
  // replace existing, if any (and if new gas is higher)
  // revets if unable to add UserOp to mempool (too many UserOps with this sender)
  addUserOp (userOp: UserOperation, userOpHash: string, prefund: BigNumberish, senderInfo: StakeInfo, referencedContracts: ReferencedCodeHashes, aggregator?: string, activeFlag?: boolean): void {
    const entry: MempoolEntry = {
      userOp,
      userOpHash,
      prefund,
      referencedContracts,
      aggregator,
      activeFlag
    }
    const index = this._findBySenderNonce(userOp.sender, userOp.nonce)
    if (index !== -1) {
      const oldEntry = this.mempool[index]
      this.checkReplaceUserOp(oldEntry, entry)
      debug('replace userOp', userOp.sender, userOp.nonce)
      this.mempool[index] = entry
    } else {
      debug('add userOp', userOp.sender, userOp.nonce)
      this.entryCount[userOp.sender] = (this.entryCount[userOp.sender] ?? 0) + 1
      this.checkSenderCountInMempool(userOp, senderInfo)
      this.mempool.push(entry)
    }
    fs.writeFileSync('./mempool.json', JSON.stringify(this.mempool))
    this.updateSeenStatus(aggregator, userOp)
  }

  private updateSeenStatus (aggregator: string | undefined, userOp: UserOperation): void {
    this.reputationManager.updateSeenStatus(aggregator)
    this.reputationManager.updateSeenStatus(getAddr(userOp.paymasterAndData))
    this.reputationManager.updateSeenStatus(getAddr(userOp.initCode))
  }

  // check if there are already too many entries in mempool for that sender.
  // (allow 4 entities if unstaked, or any number if staked)
  private checkSenderCountInMempool (userOp: UserOperation, senderInfo: StakeInfo): void {
    if ((this.entryCount[userOp.sender] ?? 0) > MAX_MEMPOOL_USEROPS_PER_SENDER) {
      // already enough entities with this sender in mempool.
      // check that it is staked
      this.reputationManager.checkStake('account', senderInfo)
    }
  }

  private checkReplaceUserOp (oldEntry: MempoolEntry, entry: MempoolEntry): void {
    const oldMaxPriorityFeePerGas = BigNumber.from(oldEntry.userOp.maxPriorityFeePerGas).toNumber()
    const newMaxPriorityFeePerGas = BigNumber.from(entry.userOp.maxPriorityFeePerGas).toNumber()
    const oldMaxFeePerGas = BigNumber.from(oldEntry.userOp.maxFeePerGas).toNumber()
    const newMaxFeePerGas = BigNumber.from(entry.userOp.maxFeePerGas).toNumber()
    // the error is "invalid fields", even though it is detected only after validation
    requireCond(newMaxPriorityFeePerGas >= oldMaxPriorityFeePerGas * 1.1,
      `Replacement UserOperation must have higher maxPriorityFeePerGas (old=${oldMaxPriorityFeePerGas} new=${newMaxPriorityFeePerGas}) `, ValidationErrors.InvalidFields)
    requireCond(newMaxFeePerGas >= oldMaxFeePerGas * 1.1,
      `Replacement UserOperation must have higher maxFeePerGas (old=${oldMaxFeePerGas} new=${newMaxFeePerGas}) `, ValidationErrors.InvalidFields)
  }

  getSortedForInclusion (): MempoolEntry[] {
    const copy = this.mempool.filter((mempoolEntry) => !(mempoolEntry.activeFlag === false))

    function cost (op: UserOperation): number {
      // TODO: need to consult basefee and maxFeePerGas
      return BigNumber.from(op.maxPriorityFeePerGas).toNumber()
    }

    copy.sort((a, b) => cost(a.userOp) - cost(b.userOp))
    return copy
  }

  _findBySenderNonce (sender: string, nonce: BigNumberish): number {
    for (let i = 0; i < this.mempool.length; i++) {
      const curOp = this.mempool[i].userOp
      if (curOp.sender === sender && curOp.nonce === nonce) {
        return i
      }
    }
    return -1
  }

  _findByHash (hash: string): number {
    for (let i = 0; i < this.mempool.length; i++) {
      const curOp = this.mempool[i]
      if (curOp.userOpHash === hash) {
        return i
      }
    }
    return -1
  }

  getMempoolEntryBySender (sender: string): MempoolEntry[] {
    const OpArray: MempoolEntry[] = []
    for (let i = 0; i < this.mempool.length; i++) {
      const curOp = this.mempool[i].userOp
      if (curOp.sender === sender) {
        OpArray.push(this.mempool[i])
      }
    }
    return OpArray
  }

  /**
   * remove UserOp from mempool. either it is invalid, or was included in a block
   * @param userOpOrHash
   */
  removeUserOp (userOpOrHash: UserOperation | string): void {
    let index: number
    if (typeof userOpOrHash === 'string') {
      index = this._findByHash(userOpOrHash)
    } else {
      index = this._findBySenderNonce(userOpOrHash.sender, userOpOrHash.nonce)
    }
    if (index !== -1) {
      const userOp = this.mempool[index].userOp
      debug('removeUserOp', userOp.sender, userOp.nonce)
      this.mempool.splice(index, 1)
      const count = (this.entryCount[userOp.sender] ?? 0) - 1
      if (count <= 0) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete this.entryCount[userOp.sender]
      } else {
        this.entryCount[userOp.sender] = count
      }
      fs.writeFileSync('./mempool.json', JSON.stringify(this.mempool))
    }
  }

  /**
   * debug: dump mempool content
   */
  dump (): MempoolDump {
    return this.mempool.map(entry => entry.userOp)
  }

  /**
   * for debugging: clear current in-memory state
   */
  clearState (): void {
    this.mempool = []
    this.entryCount = {}
    fs.writeFileSync('./mempool.json', JSON.stringify(this.mempool))
  }
}
