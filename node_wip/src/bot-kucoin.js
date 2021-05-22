import kucoin from "kucoin-node-sdk";
import { v4 as uuidv4 } from "uuid";
import chalk from "chalk";

import { inquirerImportUserDetails } from "./import.js";
import { inquirerSelectTradeConfig, inquirerInputCoin } from "./prompts.js";
import { insertIntoDB, closeDB } from "./db.js";

const bot = "kucoin";
const directory = "./#kucoin/";

export default class KucoinBot {
  #userSecrets;
  #userConfig;

  constructor() {
    this.quoteCoinBalance;
    this.baseCoinBalance;
    this.balanceBeforeTrade;
    this.tradingAmount;
    this.ticker;
    this.buyOrderId;
    this.buyOrder;
    this.sellOrderId;
    this.sellOrder;
    this.coinPair;
    this.selectedConfig;
    this.selectedCoin;
    this.dbBuyOrder = {};
    this.dbSellOrder = {};
  }

  // getters and setter, get and set value of private object variables outside the class bounds

  async initialiseAPI() {
    kucoin.init(this.#userSecrets);
  }

  async getTicker() {
    this.ticker = await kucoin.rest.Market.Symbols.getTicker(this.coinPair);
  }

  getAccountUsers() {
    return kucoin.rest.User.UserInfo.getSubUsers();
  }

  async validateAPIConnection() {
    // Function to check that connection can be established and secrets are valid
    const acctInfo = await this.getAccountUsers();
    if (acctInfo.code !== "200000") {
      throw acctInfo.msg;
    }
  }

  async getquoteCoinBalance(endpoint=false) {
    this.quoteCoinBalance = await kucoin.rest.User.Account.getAccountsList({
      type: "trade",
      currency:
        this.#userConfig["trade_configs"][this.selectedConfig]["pairing"],
    });
    // console.log(this.quoteCoinBalance);
    console.log(
      `Your ${
        this.#userConfig["trade_configs"][this.selectedConfig]["pairing"]
      } balance is ${this.quoteCoinBalance["data"][0]["available"]}\n`
    );
    if (!endpoint) {
      console.log(chalk.yellow("Please check your config before proceeding\n"));
    }
  }

  async storeBalanceBeforeTrade() {
    // Save balance before trade
    if (!this.balanceBeforeTrade) {
      this.balanceBeforeTrade = this.quoteCoinBalance;
    }
  }

  async getTradingAmount() {
    this.tradingAmount = Math.floor(
      parseFloat(this.quoteCoinBalance["data"][0]["available"]) *
        this.#userConfig["trade_configs"][this.selectedConfig][
          "buy_qty_from_wallet"
        ]
    );
    // console.log(typeof this.tradingAmount);
  }

  async marketBuyOrder() {
    // Execute market buy
    this.buyOrderId = await kucoin.rest.Trade.Orders.postOrder(
      {
        clientOid: uuidv4(),
        side: "buy",
        symbol: this.coinPair,
        type: "market",
      },
      {
        funds: this.tradingAmount,
      }
    );
  }

  async getBuyOrderDetails() {
    // Get buy order details with buyOrderId
    this.buyOrder = await kucoin.rest.Trade.Orders.getOrderByID(
      this.buyOrderId["data"]["orderId"]
    );
    console.log(this.buyOrder["data"]);
    // Validate Buy Order
    this.validateBuyOrder();
  }

  async validateBuyOrder() {
    // Check that buy order object has valid values
    if (
      this.buyOrder["data"]["dealFunds"] == 0 ||
      this.buyOrder["data"]["dealSize"] == 0
    ) {
      this.getBuyOrderDetails();
    }
  }

  async getBaseCoinBalance() {
    this.baseCoinBalance = await kucoin.rest.User.Account.getAccountsList({
      currency: this.selectedCoin,
      type: "trade",
    });
  }

  async checkMargin() {
    // Check and compare market value
    // Execute sell order if profit margin is reached
    const margin =
      this.#userConfig["trade_configs"][this.selectedConfig]["profit_margin"];
    const interval =
      this.#userConfig["trade_configs"][this.selectedConfig][
        "refresh_interval"
      ];

    this.fallbackAction();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await this.getTicker();
      try {
        if (
          parseFloat(this.ticker["data"]["price"]) >=
          (parseFloat(this.buyOrder["data"]["dealFunds"]) /
            parseFloat(this.buyOrder["data"]["dealSize"])) *
            (1.0 + margin)
        ) {
          if (this.sellOrderId == null) {
            await this.marketSellOrder();
            break;
          }
        } else {
          await new Promise((r) => setTimeout(r, interval));
        }
      } catch {
        console.log("Buy order details not received yet");
      }
      if (this.sellOrderId) {
        break;
      }
    }
  }

  async fallbackAction() {
    // Fallback function if profit margin is not reached
    const sleepDuration =
      this.#userConfig["trade_configs"][this.selectedConfig][
        "sell_fallback_timeout_ms"
      ];

    // await setTimeout. A.K.A sleep
    await new Promise((r) => setTimeout(r, sleepDuration));

    if (this.sellOrderId == null) {
      await this.marketSellOrder();
    }
  }

  async marketSellOrder() {
    // Execute sell order
    let sellQty;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        sellQty = Math.floor(
          parseFloat(this.baseCoinBalance["data"][0]["available"]) *
            this.#userConfig["trade_configs"][this.selectedConfig][
              "sell_qty_from_wallet"
            ]
        );
        break;
      } catch (error) {
        await this.getBaseCoinBalance();
      }
    }
    this.sellOrderId = await kucoin.rest.Trade.Orders.postOrder(
      {
        clientOid: uuidv4(),
        side: "sell",
        symbol: this.coinPair,
        type: "market",
      },
      {
        size: sellQty,
      }
    );
    // console.log(this.quoteCoinBalance["data"][0]['available']);
    // console.log(sellQty);
  }

  async getSellOrderDetails() {
    // Get sell order using sellOrderId
    this.sellOrder = await kucoin.rest.Trade.Orders.getOrderByID(
      this.sellOrderId["data"]["orderId"]
    );
    console.log(this.sellOrder["data"] + "\n");
  }

  async displayResults() {
    // Display pump results
    const balanceBeforeTrade = parseFloat(
      this.balanceBeforeTrade["data"][0]["available"]
    );
    const balanceAfterTrade = parseFloat(
      this.quoteCoinBalance["data"][0]["available"]
    );

    const difference = balanceAfterTrade - balanceBeforeTrade;
    const percentage = (difference / balanceBeforeTrade) * 100;

    if (balanceAfterTrade < balanceBeforeTrade) {
      console.log(chalk.yellow("A %.2f loss\n"),percentage);
    }
    if (balanceAfterTrade > balanceBeforeTrade) {
      console.log(chalk.green("A %.2f gain\n"),percentage);
    }
  }

  async prepareDBInsert() {
    // Place data into this.dbBuyOrder and this.dbSellOrder;
    // this.dbBuyOrder.clientOid 
    // this.dbBuyOrder.id
    // this.dbBuyOrder.symbol
    // this.dbBuyOrder.type
    // this.dbBuyOrder.side
    // this.dbBuyOrder.timeInForce
    // this.dbBuyOrder.createdAt
    // this.dbBuyOrder.fee
    // this.dbBuyOrder.size
    // this.dbBuyOrder.dealFunds

    // this.dbSellOrder.clientOid
    // this.dbSellOrder.id
    // this.dbSellOrder.symbol
    // this.dbSellOrder.type
    // this.dbSellOrder.side
    // this.dbSellOrder.timeInForce
    // this.dbSellOrder.createdAt
    // this.dbSellOrder.fee
    // this.dbSellOrder.size
    // this.dbSellOrder.dealFunds
  }

  async displayTimeDuration() {
    //Compute time and log to console
  }

  async timer() {}
  // changing a this.value value in an arrow function doesn't change it outside the scope
  // For Arrow functions

  async run() {
    [this.#userConfig, this.#userSecrets] = await inquirerImportUserDetails(
      bot,
      directory
    );

    await this.initialiseAPI();
    await this.validateAPIConnection();

    this.selectedConfig = await inquirerSelectTradeConfig(this.#userConfig);

    // store balance
    await this.getquoteCoinBalance();
    this.storeBalanceBeforeTrade()
    // console.log(this.quoteCoinBalance);
    await this.getTradingAmount();

    this.selectedCoin = await inquirerInputCoin();

    this.coinPair =
      (await this.selectedCoin.toUpperCase()) +
      "-" +
      this.#userConfig["trade_configs"][this.selectedConfig]["pairing"];

    // await this.getTicker();
    // console.log(await this.ticker);

    await this.marketBuyOrder();

    this.getBuyOrderDetails();
    // await this.getBuyOrderDetails();

    this.getBaseCoinBalance();
    // await this.getBaseCoinBalance();

    await this.checkMargin();
    await this.getSellOrderDetails();

    // Print Balance
    await this.getquoteCoinBalance(true);
    
    // Insert into db
    // await this.prepareDBInsert()
    // await insertIntoDB(bot, this.dbBuyOrder, this.buyOrderId["data"]["orderId"])
    await insertIntoDB(bot, this.buyOrder["data"], this.buyOrderId["data"]["orderId"])
    // await insertIntoDB(bot, this.dbSellOrder, this.sellOrderId["data"]["orderId"])
    await insertIntoDB(bot, this.sellOrder["data"], this.sellOrderId["data"]["orderId"])
    await closeDB()
    
    // Show profit gain or loss
    await this.displayResults();
    
    // Print time duration
    // await this.displayTimeDuration()
  }
}