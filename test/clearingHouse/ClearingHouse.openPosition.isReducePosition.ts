import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, b2qExactInput, b2qExactOutput, q2bExactOutput } from "../helper/clearingHouseHelper"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse isIncreasePosition when trader is both of maker and taker", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let quoteToken: QuoteToken
    let baseToken: BaseToken
    let mockedBaseAggregator: MockContract
    let pool: UniswapV3Pool
    let baseToken2: BaseToken
    let mockedBaseAggregator2: MockContract
    let pool2: UniswapV3Pool
    let lowerTick: number
    let upperTick: number
    let collateralDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        exchange = fixture.exchange
        accountBalance = fixture.accountBalance
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        collateral = fixture.USDC
        quoteToken = fixture.quoteToken
        baseToken = fixture.baseToken
        mockedBaseAggregator = fixture.mockedBaseAggregator
        pool = fixture.pool
        baseToken2 = fixture.baseToken2
        mockedBaseAggregator2 = fixture.mockedBaseAggregator2
        pool2 = fixture.pool2
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt("10", "1"))
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        await marketRegistry.addPool(baseToken.address, "10000")

        await collateral.mint(alice.address, parseUnits("3000", collateralDecimals))
        await deposit(alice, vault, 1000, collateral)

        await collateral.mint(bob.address, parseUnits("3000", collateralDecimals))
        await deposit(bob, vault, 1000, collateral)

        await collateral.mint(carol.address, parseUnits("3000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
    })

    describe("trader is both of maker and taker", async () => {
        it("reduce taker long position", async () => {
            // alice add liquidity
            await addOrder(fixture, alice, 100, 10000, lowerTick, upperTick)

            // bob swap let alice has maker position
            // alice maker positionSize : -5
            await q2bExactOutput(fixture, bob, 5)

            // alice swap
            // alice maker positionSize : -6
            await q2bExactOutput(fixture, alice, 1)

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("1"),
            )

            // alice reduce position
            // alice maker positionSize : -5.5
            await b2qExactInput(fixture, alice, 0.5)

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("0.5"),
            )

            // total position size = taker position size + maker position size
            expect(await accountBalance.getPositionSize(alice.address, baseToken.address)).to.be.closeTo(
                parseEther("-5"),
                1,
            )
        })

        it("reduce taker short position", async () => {
            // alice add liquidity
            await addOrder(fixture, alice, 100, 10000, lowerTick, upperTick)

            // bob swap let alice has maker position

            // alice maker positionSize : -5
            await q2bExactOutput(fixture, bob, 5)

            // alice swap
            // alice maker positionSize : -4
            await b2qExactInput(fixture, alice, 1)

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("-1"),
            )

            // alice reduce position
            // alice maker positionSize : -4.5
            await q2bExactOutput(fixture, alice, 0.5)

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("-0.5"),
            )

            // total position size = taker position size + maker position size
            expect(await accountBalance.getPositionSize(alice.address, baseToken.address)).to.be.closeTo(
                parseEther("-5"),
                1,
            )
        })

        it("reduce taker position and partial close", async () => {
            // set MaxTickCrossedWithinBlock so that trigger over price limit
            await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 1000)

            // alice add liquidity
            await addOrder(fixture, alice, 20, 1000, lowerTick, upperTick)

            // bob swap let alice has maker position
            // alice maker positionSize : -10
            // alice taker positionSize: 0
            await q2bExactOutput(fixture, bob, 10)

            // alice swap
            // alice maker positionSize : -15
            // alice taker positionSize : 5
            await q2bExactOutput(fixture, alice, 5)

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("5"),
            )

            // expect revert due to over price limit
            // alice reduce position
            await expect(b2qExactOutput(fixture, alice, 5)).to.be.revertedWith("EX_OPLBS")
        })
    })
})
