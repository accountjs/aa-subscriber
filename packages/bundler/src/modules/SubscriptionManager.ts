import { BigNumber, BigNumberish } from 'ethers'
import { getAddr } from './moduleUtils'
import { requireCond } from '../utils'
import { ReputationManager } from './ReputationManager'
import Debug from 'debug'
import { ReferencedCodeHashes, StakeInfo, UserOperation, ValidationErrors } from './Types'
import fs from 'fs'

const debug = Debug('aa.subscription')

export interface SubscriptionsEntry {
  address: string
  id: string
  starttime: number
  endtime: number
  interval: number
  lasttime: number
}

type SubscriptionArray = SubscriptionsEntry[]

export class SubscriptionManager {
  private subscriptions: SubscriptionsEntry[] = []

  constructor () {
    fs.exists('./subscriptions.json', (exists) => {
      if (!exists) {
        fs.writeFileSync('./subscriptions.json', JSON.stringify([]))
      }
      this.subscriptions = JSON.parse(fs.readFileSync('./subscriptions.json').toString())
    })
  }

  getAll (): SubscriptionsEntry[] {
    return this.subscriptions
  }

  count (): number {
    return this.subscriptions.length
  }

  async addSubscription (address: string, id: string, starttime: string, endtime: string, interval: string): Promise<void> {
    let starttimeint: number = parseInt(starttime)
    let endtimeint: number = parseInt(endtime)
    let intervalint: number = parseInt(interval)
    const entry: SubscriptionsEntry = {
      address: address,
      id: id,
      starttime: starttimeint,
      endtime: endtimeint,
      interval: intervalint,
      lasttime: 0
    }
    this.subscriptions.push(entry)
    fs.writeFileSync('./subscriptions.json', JSON.stringify(this.subscriptions))
  }

  _findbyAddressId (address: string, id: string): number {
    for (let i = 0; i < this.subscriptions.length; i++) {
      if (this.subscriptions[i].address === address && this.subscriptions[i].id === id) {
        return i
      }
    }
    return -1
  }

  async removeSubscription (address: string, id: string): Promise<void> {
    let index: number
    index = this._findbyAddressId(address, id)
    if (index !== -1) {
      this.subscriptions.splice(index, 1)
      fs.writeFileSync('./subscriptions.json', JSON.stringify(this.subscriptions))
    }
  }

  /**
   * for debugging: clear current in-memory state
   */
  clearState (): void {
    this.subscriptions = []
    fs.writeFileSync('./subscriptions.json', JSON.stringify(this.subscriptions))
  }
}
