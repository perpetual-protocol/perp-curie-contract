import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    BaseToken,
    MarketRegistry,
    OrderBook,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, b2qExactInput, closePosition, q2bExactInput } from "../helper/clearingHouseHelper"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt, syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse closePosition", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let orderBook: OrderBook
    let accountBalance: TestAccountBalance
    let exchange: TestExchange
    let collateral: TestERC20
    let vault: Vault
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let lowerTick: number, upperTick: number

    beforeEach(async () => {
        const uniFeeRatio = 500 // 0.05%
        const exFeeRatio = 1000 // 0.1%

        fixture = await loadFixture(createClearingHouseFixture(false, uniFeeRatio))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        exchange = fixture.exchange as TestExchange
        orderBook = fixture.orderBook
        accountBalance = fixture.accountBalance as TestAccountBalance
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        mockedBaseAggregator = fixture.mockedBaseAggregator
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        pool = fixture.pool

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt("100", "1"))
        await pool.increaseObservationCardinalityNext(500)

        // update config
        await marketRegistry.addPool(baseToken.address, uniFeeRatio)
        await marketRegistry.setFeeRatio(baseToken.address, exFeeRatio)
        await marketRegistry.setInsuranceFundFeeRatio(baseToken.address, 100000) // 10%

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // prepare collateral for alice
        const decimals = await collateral.decimals()
        await collateral.mint(alice.address, parseUnits("500000", decimals))
        await deposit(alice, vault, 100000, collateral)

        // prepare collateral for bob
        await collateral.mint(bob.address, parseUnits("100", decimals))
        await deposit(bob, vault, 100, collateral)

        // alice add liquidity
        await addOrder(fixture, alice, "500", "50000", lowerTick, upperTick, false)
    })

    describe("close/reduce position when bad debt", () => {
        describe("taker has long position and market price become lower than index price", async () => {
            beforeEach(async () => {
                // bob long base Token with 8x leverage
                // bob position size: 7.86
                await q2bExactInput(fixture, bob, "800", baseToken.address)
                await syncIndexToMarketPrice(mockedBaseAggregator, pool)

                // alice short base token that causing bob has bad debt(if he close his position)
                await b2qExactInput(fixture, alice, "5000", baseToken.address)

                // bob's account value is greater than 0 bc index price is not synchronized with mark price
                expect(await clearingHouse.getAccountValue(bob.address)).to.be.gt("0")
            })

            it("cannot close position when user has bad debt", async () => {
                await expect(closePosition(fixture, bob)).to.be.revertedWith("CH_BD")
            })

            it("cannot reduce position when user has bad debt", async () => {
                // bob position size: 7.86
                await expect(b2qExactInput(fixture, bob, "2", baseToken.address)).to.be.revertedWith("CH_BD")
            })

            it("cannot reduce when not resulting bad debt but with not enough collateral", async () => {
                await expect(b2qExactInput(fixture, bob, "0.5", baseToken.address)).to.be.revertedWith("CH_NEFCI")
            })

            it("can reduce when not resulting bad debt and has enough collateral", async () => {
                await expect(b2qExactInput(fixture, bob, "0.1", baseToken.address)).to.emit(
                    clearingHouse,
                    "PositionChanged",
                )
            })

            it("can close position by liquidation", async () => {
                // sync index price to market price so that bob can be liquidated
                await syncIndexToMarketPrice(mockedBaseAggregator, pool)

                await expect(closePosition(fixture, bob)).to.be.revertedWith("CH_BD")

                await expect(clearingHouse.connect(alice).liquidate(bob.address, baseToken.address)).to.emit(
                    clearingHouse,
                    "PositionLiquidated",
                )
            })

            it("cannot close position with partial close when trader has bad debt", async () => {
                // set max price impact to 1% to trigger partial close
                await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 500)
                await expect(closePosition(fixture, bob)).to.be.revertedWith("CH_BD")
            })
        })

        describe("taker has long position and index price becomes lower than market price", async () => {
            beforeEach(async () => {
                // bob long base Token with 8x leverage
                // bob position size: 7.86
                await q2bExactInput(fixture, bob, "800", baseToken.address)

                // index price becomes lower than market price, bob has bad debt(calc by index price)
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("10", 6), 0, 0, 0]
                })
            })

            // trader can close position even when his margin ratio is negative as long as he does not incur bad debt
            it("can close position when taker has bad debt(calc by index price) but actually not(calc by market price)", async () => {
                await closePosition(fixture, bob)
            })

            // on the contrary, the trader might not be able to reduce position because
            // the remaining position might still incur bad debt due to the bad index price
            it("cannot reduce position when taker has bad debt(calc by index price) but actually not(calc by market price)", async () => {
                await expect(b2qExactInput(fixture, bob, "1", baseToken.address)).to.be.revertedWith("CH_BD")
            })
        })
    })
})
