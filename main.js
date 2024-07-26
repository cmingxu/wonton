const { WebSocket } = require('ws')
const EventEmitter = require('events')
const fs = require('fs')
const { Address } = require('@ton/core')

const ENDPOINT = "https://prod-backend-wonton-fd36236b22c2.herokuapp.com"
const WONTON_WALLET = "UQD8ucMJDu-VfMbemse1GaSefy8DUB18VxpvbnWiHQGlGMED"
const STONFI_WALLET = "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt"
const JETTON_API = "https://tonapi.io/v2/jettons/"
const TRACE_API = "https://tonapi.io/v2/traces/"
const MY_ANTON_API = "http://49.12.81.26:8080/api/v0"
const OFFICIAL_ANTON_API = "https://anton.tools/api/v0"

const SUB_BLOCK_BODY = `
 {
   "id": 1,
   "jsonrpc": "2.0",
   "method": "subscribe_block",
   "params": [
     "workchain=-1"
   ]
 }
 `


const SUB_TRACE_BODY =`
{
  "id":1,
  "jsonrpc":"2.0",
  "method":"subscribe_trace",
  "params":[
    "ACCOUNT"
  ]
}`

const headers = {
  "Authorization": "bearer AEETAB4AU6BMELIAAAADMMZHBQOIVYFMRL7QZ77HCXATNHS5PF6CIJQJNAQRLC4OG73V2VQ",
}
const pendingTradeCache = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Wonton extends EventEmitter {
  constructor() {
    super()
  }

  async setupHTTP() {
    const traceList = await fetch("https://tonapi.io/v2/accounts/UQD8ucMJDu-VfMbemse1GaSefy8DUB18VxpvbnWiHQGlGMED/traces?limit=100", {
      headers
    })
    const data = await traceList.json()
    for(const trace of data.traces.sort((a, b) => a.utime - b.utime)) {
      if(trace.id) {
        const t = await this.buildTrade(trace.id)
        if(t) {
          this.emit("trade", t) 
        }
      }
    }
  }

  setupWS() {
    this.ws = new WebSocket("wss://tonapi.io/v2/websocket?token=AEETAB4AU6BMELIAAAADMMZHBQOIVYFMRL7QZ77HCXATNHS5PF6CIJQJNAQRLC4OG73V2VQ")
    this.ws.onopen = () => {
      this.ws.send(SUB_TRACE_BODY.replace("ACCOUNT", WONTON_WALLET))
    }

    this.ws.onmessage = async (event) => {
      const data = JSON.parse(event.data)
      console.log(data)

      if(data.params) {
        const t = await this.buildTrade(data.params.tx_hash)
        if(t) {
          this.emit("trade", t) 
        }
      }
    }

    this.ws.onerror = (err) => {
      console.error(err)
    }
  }


  async buildTrade(hash) {
    const tx = await fetch(`${TRACE_API}${hash}`, { headers })
    const result = await tx.json()

    let t = {}

    // buy jetton request
    if(isBuyIn(result)) {
      console.log("---------------- buy in ")

      t.hash1 = result.transaction.hash
      t.tradeType = "buy"
      const in_msg = result.children[0].transaction.in_msg
      if(!in_msg.decoded_body) {
        return
      }

      const contractAddress = in_msg.decoded_body.text
      if(!contractAddress) {
        console.error("no contract address")
        console.log(result.transaction.hash)
        return
      }
      t.contractAddress = contractAddress
      t.traderWallet = Address.parseRaw(in_msg.source.address).toString()
      t.traderWalletRaw = in_msg.source.address

      const usdt = await this.fetchTONPrice()
      const jetton = await this.jettonMaster(contractAddress)
      t.tokenName = jetton.metadata.name
      t.tokenSymbol = jetton.metadata.symbol
      t.tonAmount = in_msg.value / (10 ** 9)
      t.tonAmountUSD =  t.tonAmount * usdt
      t.tonPrice = usdt

      pendingTradeCache.push(t)
      return 
    } else if(isBuyOut(result)) {
      console.log("---------------- buy out ")
      const jettonTransferNode = result.children.find((c) => c.transaction.in_msg.decoded_op_name === "jetton_transfer")
      const in_msg = jettonTransferNode.transaction.in_msg
      const traderWallet = Address.parseRaw(in_msg.decoded_body.destination).toString()
      const tfound = pendingTradeCache.find((t) => t.traderWalletRaw === in_msg.decoded_body.destination)
      if(!tfound) {
        console.log(pendingTradeCache)
        console.log(pendingTradeCache.length)
        console.log(in_msg)
        return
      }
      tfound.hash2 = result.transaction.hash
      pendingTradeCache.splice(pendingTradeCache.indexOf(tfound), 1)
      tfound.tokenAmount = Number(in_msg.decoded_body.amount) / 10 ** 9
      const user = await this.getAccount(tfound.traderWalletRaw)
      tfound.userTONBalance = user.balance / (10 ** 9)

      return tfound
    }else if(isSellIn(result)) {
      console.log("---------------- sell in ")
      t.hash1 = result.transaction.hash
      const in_msg = result.children[0].transaction.in_msg
      t.tradeType = "sell"
      t.traderWallet = Address.parseRaw(result.transaction.account.address).toString()
      t.traderWalletRaw = result.transaction.account.address
      t.tokenAmount = Number(in_msg.decoded_body.amount) / 10 ** 9

      try {
        const jetton = await this.jettonMasterFromJettonWallet(result.children[0].transaction.account.address)
        t.tokenName = jetton.content_name
        t.tokenDesc = jetton.content_description
      } catch (e) {
        console.error("no jetton master")
        console.log(in_msg)
        return
      }


      pendingTradeCache.push(t)

      return
    } else if(isSellOut(result)){
      console.log("---------------- sell out")
      const payoutNode = result.children.find((c) => c.transaction.in_msg.decoded_body.text === "Wonton.fun")
      if(!payoutNode) {
        console.error("no payout node")
        console.log(result.children[0].transaction)
        console.log(result.children[1].transaction)
        return
      }
      const in_msg = payoutNode.transaction.in_msg
      const tfound = pendingTradeCache.find((t) => t.traderWalletRaw === in_msg.destination.address)
      if(!tfound) {
        console.error("no matching trade")
        console.log(pendingTradeCache)
        console.log(result.children[0].transaction.hash)
        console.log(in_msg)
        return
      }
      pendingTradeCache.splice(pendingTradeCache.indexOf(t),1)
      tfound.hash2 = result.transaction.hash
      tfound.tonAmount = in_msg.value / (10 ** 9)
      const usdt = await this.fetchTONPrice()
      tfound.tonAmountUSD = Number(t.tonAmount) * Number(usdt)
      tfound.tonPrice = usdt

      const user = await this.getAccount(tfound.traderWalletRaw)
      tfound.userTONBalance = user.balance / (10 ** 9)
      return tfound
    }else{
      console.log("not a trade transaction")
      console.log(result)
    }
  }

  async jettonMaster(address) {
    const jetton = await fetch(`${JETTON_API}${address}`, {
      headers
    })
    return await jetton.json()
  }


  async getAccount(address) {
    const accountPath = `/accounts?address=${address}&latest=true`
    const resp = await this.fetchAnton(accountPath)
    return resp.results[0]
  }

  async jettonMasterFromJettonWallet(address) {
    const jettonMasterPath = "/accounts?latest=true&address=" + address
    const resp = await this.fetchAnton(jettonMasterPath)
    if(resp.total !== 1) {
      throw new Error("no jetton master found")
    }


    const minterAddress = `/accounts?latest=true&address=${resp.results[0].minter_address.base64}`
    const jetton = await this.fetchAnton(minterAddress)
    if(jetton.total !== 1) {
      throw new Error("no jetton found")
    }

    return jetton.results[0]
  }

  async fetchAnton(path) {
    const response = await fetch(`${MY_ANTON_API}${path}`)
    const x =  await response.json()
    if(x.total !== 0) {
      return x
    }

    const response1 = await fetch(`${OFFICIAL_ANTON_API}${path}`)
    const y =  await response1.json()
    return y
  }

  async fetchTONPrice(asset='ton') {
    const response = await fetch(`https://tonapi.io/v2/rates?tokens=${asset}&currencies=usd`, {
      params: {
        tokens: "usdt",
        currencies: "usd"
      },
      headers
    })
    const data = await response.json()
    if (data.rates)
      return data.rates.TON.prices.USD
    else return -1
  }

}

const sleep1 = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const main = async () => {
  try {
    const wonton = new Wonton()

    wonton.on("trade", (data) => {
      console.log("trade", data)
    })

    wonton.setupWS()
    //
    // await wonton.setupHTTP()


    while(true) {
      await sleep(1)
    }

  } catch (e) {
    console.error(e)
  }
}

const isBuyIn = (trace) => {
  return (trace.interfaces.includes("wallet_v4r2") || 
    trace.interfaces.includes("wallet_v3r2")) &&
    trace.children.length === 1 &&
    trace.children[0].interfaces.includes("wallet_highload_v2")
}

const isBuyOut = (trace) => {
  return trace.interfaces.includes("wallet_highload_v2") &&
    trace.children.length === 2 && (
      trace.children[0].transaction.in_msg.decoded_op_name === "jetton_transfer" ||
      trace.children[1].transaction.in_msg.decoded_op_name === "jetton_transfer"
    ) 
}

const isSellIn = (trace) => {
  return (trace.interfaces.includes("wallet_v4r2") || 
    trace.interfaces.includes("wallet_v3r2")) &&
    trace.children.length === 1 &&
    trace.children[0].interfaces.includes("jetton_wallet")

}
const isSellOut = (trace) => {
  return trace.interfaces.includes("wallet_highload_v2") &&
    trace.children.length === 2 &&
    (trace.children[1].interfaces.includes("wallet_v4r2") || 
      trace.children[1].interfaces.includes("wallet_v3r2")) &&
    trace.children[1].transaction.in_msg.decoded_op_name === "text_comment"
}

main().then(() => {
  console.log("done")
})

