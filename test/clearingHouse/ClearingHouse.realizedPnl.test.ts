import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { formatEther, formatUnits, parseEther, parseUnits } from "ethers/lib/utils"
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
import base = Mocha.reporters.base

describe("ClearingHouse realizedPnl", () => {
    const [admin, maker, maker2, taker, carol] = waffle.provider.getWallets()
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
        console.log("==== maker add liquidity ====")
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
        // maker
        //   pool.base = 99.999999999999999999
        console.log(
            `  maker.pool.base.balance: ${formatEther(
                await orderBook.getTotalTokenAmountInPool(maker.address, baseToken.address, true),
            )}`,
        )
        console.log(
            `  maker.liquidity: ${formatEther(
                (await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)).liquidity,
            )}`,
        )

        // prepare collateral for taker
        const takerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
        await deposit(taker, vault, 1000, collateral)
    })

    function findPositionChangedEvent(receipt: TransactionReceipt): LogDescription {
        const positionChangedTopic = exchange.interface.getEventTopic("PositionChanged")
        return exchange.interface.parseLog(receipt.logs.find(log => log.topics[0] === positionChangedTopic))
    }

    it.only("has zero aggregated realized PnL", async () => {
        console.log("==== taker takes ====")
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

        console.log("==== taker closes ====")
        const takerCloseReceipt = await (
            await clearingHouse.connect(taker).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: parseEther("0"),
                oppositeAmountBound: parseEther("0"),
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        ).wait()
        console.log(
            `  taker.positionSize: ${formatEther(
                await accountBalance.getPositionSize(taker.address, baseToken.address),
            )}`,
        )
        console.log(
            `  taker.openNotional: ${formatEther(await exchange.getOpenNotional(taker.address, baseToken.address))}`,
        )
        console.log(`  taker.realizedPnl: ${formatEther(findPositionChangedEvent(takerCloseReceipt).args.realizedPnl)}`)
        console.log(
            `  taker.owedRealizedPnl: ${formatEther((await accountBalance.getOwedAndUnrealizedPnl(taker.address))[0])}`,
        )
        console.log(
            `  maker.positionSize: ${formatEther(
                await accountBalance.getPositionSize(maker.address, baseToken.address),
            )}`,
        )
        console.log(
            `  maker.openNotional: ${formatEther(await exchange.getOpenNotional(maker.address, baseToken.address))}`,
        )

        console.log("==== maker remove liquidity ====")
        await clearingHouse.connect(maker).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity: (await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)).liquidity,
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
            `  maker.liquidity: ${formatEther(
                (await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)).liquidity,
            )}`,
        )
        console.log(
            `  maker.openNotional: ${formatEther(await exchange.getOpenNotional(maker.address, baseToken.address))}`,
        )
        console.log(
            `  maker.owedRealizedPnl: ${formatEther((await accountBalance.getOwedAndUnrealizedPnl(maker.address))[0])}`,
        )

        console.log("==== taker withdraw all ====")
        const takerFreeCollateral = await vault.getFreeCollateral(taker.address)
        console.log(`  taker.vaultBalanceOf: ${formatUnits(await vault.balanceOf(taker.address), collateralDecimals)}`)
        console.log(`  taker.freeCollateral: ${formatUnits(takerFreeCollateral, collateralDecimals)}`)
        console.log(
            `  taker.owedRealizedPnl: ${formatEther((await accountBalance.getOwedAndUnrealizedPnl(taker.address))[0])}`,
        )
        await vault.withdraw(collateral.address, takerFreeCollateral)
        console.log(
            `  taker.USDCbalance: ${formatUnits(await collateral.balanceOf(taker.address), collateralDecimals)}`,
        )

        console.log("==== maker withdraw all ====")
        const makerFreeCollateral = await vault.getFreeCollateral(maker.address)
        console.log(`  maker.freeCollateral: ${formatUnits(makerFreeCollateral, collateralDecimals)}`)
        console.log(
            `  maker.owedRealizedPnl: ${formatEther((await accountBalance.getOwedAndUnrealizedPnl(maker.address))[0])}`,
        )
        await vault.withdraw(collateral.address, makerFreeCollateral)
        console.log(
            `  maker.USDCbalance: ${formatUnits(await collateral.balanceOf(maker.address), collateralDecimals)}`,
        )
    })
})
