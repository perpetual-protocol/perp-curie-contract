import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { formatEther, formatUnits, parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, closePosition, q2bExactInput } from "../helper/clearingHouseHelper"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt, formatSqrtPriceX96ToPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse 7494 bad debt attack", () => {
    const [admin, maker, account1, account2] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let insuranceFund: InsuranceFund
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let tickSpacing: number
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    let fixture: ClearingHouseFixture
    let minTick: number
    let maxTick: number

    const indexPrice = 1.3

    beforeEach(async () => {
        const uniFeeRatio = 500 // 0.05%
        const exFeeRatio = 1000 // 0.1%

        fixture = await loadFixture(createClearingHouseFixture(false, uniFeeRatio))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        accountBalance = fixture.accountBalance
        vault = fixture.vault
        insuranceFund = fixture.insuranceFund
        exchange = fixture.exchange
        marketRegistry = fixture.marketRegistry
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        quoteToken = fixture.quoteToken
        pool = fixture.pool
        mockedBaseAggregator = fixture.mockedBaseAggregator
        collateralDecimals = await collateral.decimals()

        // set oracle price to 1.3, simulating SAND POOL
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(indexPrice.toString(), 6), 0, 0, 0]
        })

        // tick space: 10
        tickSpacing = await pool.tickSpacing()
        minTick = getMinTick(tickSpacing)
        maxTick = getMaxTick(tickSpacing)
        await pool.initialize(encodePriceSqrt("13", "10")) // tick = 2623 (1.0001^2623 = 1.29989941), simulating SAND POOL
        await pool.increaseObservationCardinalityNext(500)

        await marketRegistry.addPool(baseToken.address, uniFeeRatio)
        await marketRegistry.setFeeRatio(baseToken.address, exFeeRatio)
        await marketRegistry.setInsuranceFundFeeRatio(baseToken.address, 100000) // 10%
        await exchange.setMaxTickCrossedWithinBlock(baseToken.address, "250")

        // prepare collateral for makers
        const makerAmount = parseUnits("500000", collateralDecimals)
        await collateral.mint(maker.address, makerAmount) //
        await deposit(maker, vault, 500000, collateral)
        // add a full range liquidity
        await addOrder(fixture, maker, 1500000, 500000, minTick, maxTick)
        const ids = await orderBook.getOpenOrderIds(maker.address, baseToken.address)
    })

    function getLatestTickBelowPrice(price: number, curTick: number) {
        const getBaseLog = (x: number, y: number) => Math.log(y) / Math.log(x)
        let tick = getBaseLog(1.0001, price)
        tick = Math.round(Math.round(tick) / 10) * 10 // tick space is 10
        while (tick > curTick) {
            tick -= 10
        }
        return tick
    }

    async function manipulatePrice(endPrice: number) {
        console.log("===================================== test end price:", endPrice)
        const account1Margin = parseUnits("220000", collateralDecimals)
        await collateral.mint(account1.address, account1Margin)
        await deposit(account1, vault, 220000, collateral)

        // account1 keeps opening long positions and push the price to $4
        let price: number
        let count = 0
        while (true) {
            const slot0 = await pool.slot0()
            price = Number(formatSqrtPriceX96ToPrice(slot0.sqrtPriceX96))
            if (price >= endPrice) break

            await q2bExactInput(fixture, account1, 6300)
            count++
        }

        console.log(`txs count: ${count}`)
        const freeCollateralAfterOpenLong = await vault.getFreeCollateral(account1.address)
        const account1MinimalMargin = formatUnits(
            account1Margin.sub(freeCollateralAfterOpenLong).toString(),
            collateralDecimals,
        )
        console.log(`minimal margin for account1: ${account1MinimalMargin.toString()}`)
    }

    async function testBlockBadDebtAttack() {
        const positionSize = formatEther(
            (await accountBalance.getTakerPositionSize(account1.address, baseToken.address)).toString(),
        )

        const slot0 = await pool.slot0()
        const price = Number(formatSqrtPriceX96ToPrice(slot0.sqrtPriceX96))
        const tick = slot0.tick
        console.log("===================================== test mark price:", price)

        // account2 deposit margin with amount same to the account1's position notional
        const account2Margin = Math.round(Number(positionSize) * price) / 10 + 10
        console.log(`minimal margin for account2: ${account2Margin}`)
        const accoun2MarginInWei = parseUnits(account2Margin.toString(), collateralDecimals)
        await collateral.mint(account2.address, accoun2MarginInWei)
        await deposit(account2, vault, account2Margin, collateral)

        const upperTick = getLatestTickBelowPrice(price, tick)
        // account2 add single side liquidity just below the end price
        await expect(addOrder(fixture, account2, 0, account2Margin * 10, upperTick - 10, upperTick)).to.be.revertedWith(
            "CH_OMPS",
        )
    }

    async function testNoProfit(isBadDebt: boolean) {
        const positionSize = formatEther(
            (await accountBalance.getTakerPositionSize(account1.address, baseToken.address)).toString(),
        )

        const slot0 = await pool.slot0()
        const price = Number(formatSqrtPriceX96ToPrice(slot0.sqrtPriceX96))
        const tick = slot0.tick
        console.log("===================================== test mark price:", price)

        // account2 deposit margin with amount same to the account1's position notional
        const account2Margin = Math.round(Number(positionSize) * price) / 10 + 10
        console.log(`minimal margin for account2: ${account2Margin}`)
        const accoun2MarginInWei = parseUnits(account2Margin.toString(), collateralDecimals)
        await collateral.mint(account2.address, accoun2MarginInWei)
        await deposit(account2, vault, account2Margin, collateral)

        const upperTick = getLatestTickBelowPrice(price, tick)
        // account2 add single side liquidity just below the end price

        await addOrder(fixture, account2, 0, account2Margin * 10, upperTick - 10, upperTick)
        // account1 close position at end price
        await closePosition(fixture, account1)

        // account2 might be in bad debt status
        const account2AccountValue = await vault.getAccountValue(account2.address)
        if (isBadDebt) {
            expect(account2AccountValue).to.be.lt("0")
        } else {
            expect(account2AccountValue).to.be.gte("0")
        }

        // account1's free collateral now greater than account1 & account2's margin
        const account1FreeCollateral = await vault.getFreeCollateral(account1.address)
        // console.log(`account1's free collateral: ${formatUnits(account1FreeCollateral.toString(), collateralDecimals)}`)

        const account1Margin = await vault.getBalance(account1.address)
        const profit = account1FreeCollateral.sub(account1Margin.add(accoun2MarginInWei))
        expect(profit).to.be.lt("0")
        console.log(`profit: ${formatUnits(profit, collateralDecimals)}`)
    }

    it("end price $1.43 (spread 10%)", async () => {
        await manipulatePrice(1.43)
        // account 2 has no bad debt
        // account 1 should have no profit
        await testNoProfit(false)
    })

    it("end price $1.53 (spread 20%)", async () => {
        await manipulatePrice(1.53)
        // account 2 has bad debt
        // account 1 should have no profit
        await testNoProfit(true)
    })

    it("end price $1.7", async () => {
        await manipulatePrice(1.7)
        // account 2 can not add liquidity
        await testBlockBadDebtAttack()
    })
})
