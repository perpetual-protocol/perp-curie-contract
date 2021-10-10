import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { formatEther, parseEther, parseUnits } from "ethers/lib/utils"
import { TransactionReceipt } from "@ethersproject/abstract-provider"
import { LogDescription } from "@ethersproject/abi"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouseConfig,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse realizedPnl", () => {
    const [admin, maker, taker] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let clearingHouseConfig: ClearingHouseConfig
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let baseToken2: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let mockedBaseAggregator2: MockContract
    let collateralDecimals: number
    let takerUsdcBalanceBefore: BigNumber
    const lowerTick: number = 46200
    const upperTick: number = 46400

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        accountBalance = _clearingHouseFixture.accountBalance
        clearingHouseConfig = _clearingHouseFixture.clearingHouseConfig
        vault = _clearingHouseFixture.vault
        exchange = _clearingHouseFixture.exchange
        marketRegistry = _clearingHouseFixture.marketRegistry
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        baseToken2 = _clearingHouseFixture.baseToken2
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        mockedBaseAggregator2 = _clearingHouseFixture.mockedBaseAggregator2
        pool = _clearingHouseFixture.pool
        pool2 = _clearingHouseFixture.pool2
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt("100", "1")) // tick = 46000 (1.0001^46000 = 99.4614384055)
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        // add pool after it's initialized
        await marketRegistry.addPool(baseToken.address, 10000)
        await marketRegistry.setFeeRatio(baseToken.address, 10000)

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("0"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
        // maker base token amount in pool = 99.999999999999999999

        // prepare collateral for taker
        takerUsdcBalanceBefore = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker.address, takerUsdcBalanceBefore)
        await collateral.connect(taker).approve(clearingHouse.address, takerUsdcBalanceBefore)
        await deposit(taker, vault, 1000, collateral)
    })

    function findPositionChangedEvent(receipt: TransactionReceipt): LogDescription {
        const positionChangedTopic = exchange.interface.getEventTopic("PositionChanged")
        return exchange.interface.parseLog(receipt.logs.find(log => log.topics[0] === positionChangedTopic))
    }

    function findLiquidityChangedEvent(receipt: TransactionReceipt): LogDescription {
        const liquidityChangedTopic = orderBook.interface.getEventTopic("LiquidityChanged")
        return orderBook.interface.parseLog(receipt.logs.find(log => log.topics[0] === liquidityChangedTopic))
    }

    it.only("has balanced realized PnL", async () => {
        // taker long $100 ETH
        await clearingHouse.connect(taker).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            amount: parseEther("100"),
            oppositeAmountBound: parseEther("0"),
            deadline: ethers.constants.MaxUint256,
            sqrtPriceLimitX96: parseEther("0"),
            referralCode: ethers.constants.HashZero,
        })
        // taker.positionSize: 0.975557443213784206
        // taker.openNotional: -100.0
        // maker.positionSize: -0.975557443213784207
        // maker.openNotional: 99.999999999999999998

        // maker move all liquidity and collect fee
        console.log("==== maker move liquidity (remove) ====")
        const makerMoveLiquidityRemoveReceipt = await (
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
        const takerOpenFee = findLiquidityChangedEvent(makerMoveLiquidityRemoveReceipt).args.quoteFee
        console.log(
            `  taker.positionSize: ${formatEther(
                await accountBalance.getPositionSize(taker.address, baseToken.address),
            )}`,
        )
        console.log(
            `  taker.openNotional: ${formatEther(await exchange.getOpenNotional(taker.address, baseToken.address))}`,
        )
        console.log(`  maker.takerOpenFee: ${formatEther(takerOpenFee)}`)
        console.log(
            `  maker.positionSize: ${formatEther(
                await accountBalance.getPositionSize(maker.address, baseToken.address),
            )}`,
        )
        console.log(
            `  maker.openNotional: ${formatEther(await exchange.getOpenNotional(maker.address, baseToken.address))}`,
        )
        console.log("==== maker move liquidity (add) ====")
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("0"),
            quote: parseEther("10000"),
            lowerTick: lowerTick - 1000, // lower the price for about 10%
            upperTick: upperTick - 1000, // lower the price for about 10%
            minBase: parseEther("0"),
            minQuote: parseEther("0"),
            deadline: ethers.constants.MaxUint256,
        })
        console.log(
            `  taker.positionSize: ${formatEther(
                await accountBalance.getPositionSize(taker.address, baseToken.address),
            )}`,
        )
        console.log(
            `  taker.openNotional: ${formatEther(await exchange.getOpenNotional(taker.address, baseToken.address))}`,
        )
        console.log(
            `  maker.positionSize: ${formatEther(
                await accountBalance.getPositionSize(maker.address, baseToken.address),
            )}`,
        )
        console.log(
            `  maker.openNotional: ${formatEther(await exchange.getOpenNotional(maker.address, baseToken.address))}`,
        )

        // taker close position
        console.log("==== taker close position ====")
        const takerCloseReceipt = await (
            await clearingHouse.connect(taker).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: parseEther("0"),
                oppositeAmountBound: parseEther("0"),
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        ).wait()
        const takerRealizedPnl = findPositionChangedEvent(takerCloseReceipt).args.realizedPnl
        // taker.positionSize: 0.0
        // taker.openNotional: 0.0
        // taker.owedRealizedPnl: -1.990000000000000016
        // maker.positionSize: 0.0
        // maker.openNotional: 1.990000000000000014
        console.log(`  taker.realizedPnl: ${formatEther(takerRealizedPnl)}`)
        console.log(
            `  taker.positionSize: ${formatEther(
                await accountBalance.getPositionSize(taker.address, baseToken.address),
            )}`,
        )
        console.log(
            `  taker.openNotional: ${formatEther(await exchange.getOpenNotional(taker.address, baseToken.address))}`,
        )
        console.log(
            `  maker.positionSize: ${formatEther(
                await accountBalance.getPositionSize(maker.address, baseToken.address),
            )}`,
        )
        console.log(
            `  maker.openNotional: ${formatEther(await exchange.getOpenNotional(maker.address, baseToken.address))}`,
        )

        // maker remove all liquidity and collect fee
        console.log("==== maker remove liquidity ====")
        const makerRemoveLiquidityReceipt = await (
            await clearingHouse.connect(maker).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick - 1000,
                upperTick: upperTick - 1000,
                liquidity: (
                    await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick - 1000, upperTick - 1000)
                ).liquidity,
                minBase: parseEther("0"),
                minQuote: parseEther("0"),
                deadline: ethers.constants.MaxUint256,
            })
        ).wait()
        const takerCloseFee = findLiquidityChangedEvent(makerRemoveLiquidityReceipt).args.quoteFee
        // maker.positionSize: 0.0
        // maker.liquidity: 0.0
        // maker.openNotional: 0.000000000000000015
        // maker.owedRealizedPnl: 1.989999999999999999
        console.log(
            `  taker.positionSize: ${formatEther(
                await accountBalance.getPositionSize(taker.address, baseToken.address),
            )}`,
        )
        console.log(
            `  taker.openNotional: ${formatEther(await exchange.getOpenNotional(taker.address, baseToken.address))}`,
        )
        console.log(`  maker.takerCloseFee: ${formatEther(takerCloseFee)}`)
        console.log(
            `  maker.positionSize: ${formatEther(
                await accountBalance.getPositionSize(maker.address, baseToken.address),
            )}`,
        )
        const makerRemainingOpenNotional = await exchange.getOpenNotional(maker.address, baseToken.address)
        console.log(`  maker.openNotional: ${formatEther(makerRemainingOpenNotional)}`)
        console.log(
            `  maker.owedRealizedPnl: ${formatEther((await accountBalance.getOwedAndUnrealizedPnl(maker.address))[0])}`,
        )

        // maker settle remaining quote balance
        // TODO need an event or otherwise the indexer won't be notified
        console.log("==== maker settle remaining quote balance ====")
        await exchange.connect(maker).settleQuoteBalance(maker.address, baseToken.address)
        console.log(
            `  taker.positionSize: ${formatEther(
                await accountBalance.getPositionSize(taker.address, baseToken.address),
            )}`,
        )
        console.log(
            `  taker.openNotional: ${formatEther(await exchange.getOpenNotional(taker.address, baseToken.address))}`,
        )
        console.log(`  maker.takerCloseFee: ${formatEther(takerCloseFee)}`)
        console.log(
            `  maker.positionSize: ${formatEther(
                await accountBalance.getPositionSize(maker.address, baseToken.address),
            )}`,
        )
        console.log(
            `  maker.openNotional: ${formatEther(await exchange.getOpenNotional(maker.address, baseToken.address))}`,
        )
        console.log(
            `  maker.owedRealizedPnl: ${formatEther((await accountBalance.getOwedAndUnrealizedPnl(maker.address))[0])}`,
        )

        // taker and maker's realized PnL (plus fee) should balance out each other (with some precision errors)
        // TODO WIP how to deal with maker's remaining open notional?
        expect(takerRealizedPnl.add(takerOpenFee).add(takerCloseFee).add(makerRemainingOpenNotional)).to.be.eq(
            parseEther("-0.000000000000000004"),
        )

        // taker withdraw all collaterals
        const takerFreeCollateral = await vault.getFreeCollateral(taker.address)
        // taker.vaultBalanceOf: 1000.0
        // taker.freeCollateral: 990.457988
        // taker.owedRealizedPnl: -9.542011399247233633
        // taker.USDCbalance: 0.0

        await vault.connect(taker).withdraw(collateral.address, takerFreeCollateral)
        const takerUsdcBalance = await collateral.balanceOf(taker.address)
        // taker.vaultBalanceOf: 0.0
        // taker.freeCollateral: 0.0
        // taker.USDCbalance: 990.457988

        // 1000 + (-9.542011399247233633) = 990.457988
        expect(takerUsdcBalance).to.deep.eq(parseUnits("990.457988", collateralDecimals))

        // maker withdraw all
        // TODO WIP maker free collateral lower than expected due to remaining open notional
        const makerFreeCollateral = await vault.getFreeCollateral(maker.address)
        // maker.vaultBalanceOf: 1000000.0
        // maker.freeCollateral: 1000001.989998
        // maker.owedRealizedPnl: 9.542011399247233629
        // maker.USDCbalance: 0.0

        await vault.connect(maker).withdraw(collateral.address, makerFreeCollateral)
        const makerUsdcBalance = await collateral.balanceOf(maker.address)
        // maker.vaultBalanceOf(after): 0.000001
        // maker.freeCollateral(after): 0.0
        // maker.USDCbalance(after): 1,000,009.542010

        // 1,000,000 + 9.542011399247233629 = 1,000,009.542010
        expect(makerUsdcBalance).to.deep.eq(parseUnits("1000009.542010", collateralDecimals))
    })
})
