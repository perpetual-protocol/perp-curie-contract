import { MockContract } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { ContractReceipt } from "@ethersproject/contracts"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import _ from "lodash"
import {
    AccountBalance,
    BaseToken,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    TestClearingHouse,
    TestERC20,
    Vault,
} from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { forwardBothTimestamps } from "../shared/time"
import { filterLogs, mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

// WARNING: this test is outdated and will need to catch up with many upgrades if we'd like to run it
describe.skip("ClearingHouse accounting", () => {
    const [admin, maker, taker1, taker2, taker3] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let insuranceFund: InsuranceFund
    let collateral: TestERC20
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number

    let maxTick: number, minTick: number
    const [lowerTick, upperTick] = [43980, 48000]
    let getTakerRealizedPnlAndFees: (receipt: ContractReceipt) => [BigNumber, BigNumber]
    let getMakerQuoteFees: (receipt: ContractReceipt) => BigNumber
    let getFundingPayment: (receipt: ContractReceipt) => BigNumber

    let takerCollateralAmount: BigNumber
    let makerCollateralAmount: BigNumber

    let totalTakerRealizedPnl: BigNumber
    let totalFundingPayment: BigNumber
    let totalTakerFees: BigNumber

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture(undefined, 3000))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        accountBalance = fixture.accountBalance
        vault = fixture.vault
        insuranceFund = fixture.insuranceFund
        exchange = fixture.exchange
        marketRegistry = fixture.marketRegistry
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateralDecimals = await collateral.decimals()

        getTakerRealizedPnlAndFees = (receipt: ContractReceipt): [BigNumber, BigNumber] => {
            const logs = filterLogs(receipt, clearingHouse.interface.getEventTopic("PositionChanged"), clearingHouse)
            let realizedPnl = BigNumber.from(0)
            let fees = BigNumber.from(0)
            for (const log of logs) {
                realizedPnl = realizedPnl.add(log.args.realizedPnl)
                fees = fees.add(log.args.fee)
            }
            return [realizedPnl, fees]
        }

        getMakerQuoteFees = (receipt: ContractReceipt): BigNumber => {
            const logs = filterLogs(receipt, orderBook.interface.getEventTopic("LiquidityChanged"), orderBook)
            let amount = BigNumber.from(0)
            for (const log of logs) {
                amount = amount.add(log.args.quoteFee)
            }
            return amount
        }

        getFundingPayment = (receipt: ContractReceipt): BigNumber => {
            const logs = filterLogs(receipt, exchange.interface.getEventTopic("FundingPaymentSettled"), clearingHouse)
            let fundingPayment = BigNumber.from(0)
            for (const log of logs) {
                fundingPayment = fundingPayment.add(log.args.fundingPayment)
            }
            return fundingPayment
        }

        await mockIndexPrice(mockedPriceFeedDispatcher, "100")

        const initPrice = "100"
        // add pool with 0.3% fee
        let { maxTick, minTick } = await initMarket(fixture, initPrice, 1000)

        // prepare collateral for maker
        makerCollateralAmount = parseUnits("1000000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000000, collateral)

        // maker add a v2 style liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("10000"),
            lowerTick: minTick,
            upperTick: maxTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // maker add another v3 style liquidity in range [43980, 48000]
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("20"),
            quote: parseEther("20000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for takers
        takerCollateralAmount = parseUnits("10000000", collateralDecimals)
        await collateral.mint(taker1.address, takerCollateralAmount)
        await collateral.connect(taker1).approve(clearingHouse.address, takerCollateralAmount)
        await deposit(taker1, vault, 1000, collateral)

        await collateral.mint(taker2.address, takerCollateralAmount)
        await collateral.connect(taker2).approve(clearingHouse.address, takerCollateralAmount)
        await deposit(taker2, vault, 1000, collateral)

        await collateral.mint(taker3.address, takerCollateralAmount)
        await collateral.connect(taker3).approve(clearingHouse.address, takerCollateralAmount)
        await deposit(taker3, vault, 1000, collateral)

        totalFundingPayment = BigNumber.from(0)
        totalTakerRealizedPnl = BigNumber.from(0)
        totalTakerFees = BigNumber.from(0)
        // takers do some random trades
        for (let i = 0; i < 50; i++) {
            const quoteAmount = `${Math.floor((Math.random() + 0.1) * 300)}`
            const isBaseToQuote = _.sample([true, false])
            const taker = _.sample([taker1, taker2, taker3])

            // randomly open a position and calc realized pnl
            const receipt = await (
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote,
                    isExactInput: isBaseToQuote ? false : true,
                    oppositeAmountBound: 0,
                    amount: quoteAmount,
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
            ).wait()
            totalFundingPayment = totalFundingPayment.add(getFundingPayment(receipt))
            const [realizedPnl, fee] = getTakerRealizedPnlAndFees(receipt)
            totalTakerRealizedPnl = totalTakerRealizedPnl.add(realizedPnl)
            totalTakerFees = totalTakerFees.add(fee)

            await forwardBothTimestamps(clearingHouse, 300)
        }
    })

    it("sum of all positions should be close to zero", async () => {
        // taker and maker's position size
        let totalPositionSize = BigNumber.from(0)

        for (const user of [maker, taker1, taker2, taker3]) {
            totalPositionSize = totalPositionSize.add(
                await accountBalance.getTotalPositionSize(user.address, baseToken.address),
            )
        }
        // sum of position size should be close to zero
        expect(totalPositionSize).to.closeTo("0", 50)
    })

    it("sum of all funding payments should be close to zero", async () => {
        // maker remove all liquidity and settle all funding payment
        for (const user of [maker, taker1, taker2, taker3]) {
            totalFundingPayment = totalFundingPayment.add(
                await exchange.getPendingFundingPayment(user.address, baseToken.address),
            )
        }
        expect(totalFundingPayment).to.closeTo("0", 50)
    })

    it("sum of realized pnl should close to zero after everyone close positions", async () => {
        for (const taker of [taker1, taker2, taker3]) {
            const positionSize = await accountBalance.getTotalPositionSize(taker.address, baseToken.address)
            if (positionSize.eq(0)) {
                continue
            }

            const receipt = await (
                await clearingHouse.connect(taker).closePosition({
                    baseToken: baseToken.address,
                    sqrtPriceLimitX96: parseEther("0"),
                    oppositeAmountBound: parseEther("0"),
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
            ).wait()

            const [realizedPnl, fee] = getTakerRealizedPnlAndFees(receipt)
            totalTakerRealizedPnl = totalTakerRealizedPnl.add(realizedPnl)
            totalTakerFees = totalTakerFees.add(fee)
        }

        // maker's position size should be close to 0
        const makerPositionSize = await accountBalance.getTotalPositionSize(maker.address, baseToken.address)
        expect(makerPositionSize).to.closeTo("0", 200)

        // maker remove all liquidity and collect fee
        let makerFee = BigNumber.from(0)
        let receipt = await (
            await clearingHouse.connect(maker).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: minTick,
                upperTick: maxTick,
                liquidity: (await orderBook.getOpenOrder(maker.address, baseToken.address, minTick, maxTick)).liquidity,
                minBase: parseEther("0"),
                minQuote: parseEther("0"),
                deadline: ethers.constants.MaxUint256,
            })
        ).wait()
        makerFee = makerFee.add(getMakerQuoteFees(receipt))

        receipt = await (
            await clearingHouse.connect(maker).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: (
                    await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)
                ).liquidity,
                minBase: parseEther("0"),
                minQuote: parseEther("0"),
                deadline: ethers.constants.MaxUint256,
            })
        ).wait()
        makerFee = makerFee.add(getMakerQuoteFees(receipt))

        const insuranceFundFee = (await accountBalance.getPnlAndPendingFee(insuranceFund.address))[0]

        // maker's fee + insurance fund fee should be close to taker's fees paid
        expect(makerFee.add(insuranceFundFee)).to.closeTo(totalTakerFees, 10)

        // there's an error about 3000wei
        expect(totalTakerRealizedPnl.add(makerFee).add(insuranceFundFee)).to.closeTo("0", 3000)
    })
})
