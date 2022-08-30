import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber, BigNumberish } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
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
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTickRange } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse removeLiquidity slippage", () => {
    const [admin, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let baseAmount: BigNumber
    let quoteAmount: BigNumber

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        exchange = fixture.exchange
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        quoteToken = fixture.quoteToken
        pool = fixture.pool
        mockedBaseAggregator = fixture.mockedBaseAggregator
        baseAmount = parseUnits("100", await baseToken.decimals())
        quoteAmount = parseUnits("10000", await quoteToken.decimals())

        // mint
        collateral.mint(admin.address, parseEther("10000"))

        // prepare collateral for alice
        const amount = parseUnits("1000", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 1000, collateral)
    })

    describe("# removeLiquidity failed at tick 50199", () => {
        let liquidity: BigNumberish
        beforeEach(async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("151", 6), 0, 0, 0]
            })
            await initAndAddPool(
                fixture,
                pool,
                baseToken.address,
                encodePriceSqrt("151.373306858723226651", "1"), // tick = 50199 (1.0001^50199 = 151.373306858723226651)
                10000,
                // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                getMaxTickRange(),
            )

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseUnits("1", await baseToken.decimals()),
                quote: 0,
                lowerTick: 50200,
                upperTick: 50400,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })
            const order = await orderBook.getOpenOrder(alice.address, baseToken.address, 50200, 50400)
            liquidity = order.liquidity
        })

        it("force error, over slippage protection when removing liquidity above price with only base", async () => {
            await expect(
                clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50200,
                    upperTick: 50400,
                    liquidity,
                    minBase: parseUnits("101"),
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.revertedWith("CH_PSCF")
        })

        it("force error, over deadline", async () => {
            const now = (await waffle.provider.getBlock("latest")).timestamp
            await clearingHouse.setBlockTimestamp(now + 1)

            await expect(
                clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50200,
                    upperTick: 50400,
                    liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: now,
                }),
            ).to.revertedWith("CH_TE")
        })
    })

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1155466937
    describe("# removeLiquidity failed at tick 50200", () => {
        let liquidity: BigNumberish
        beforeEach(async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("151", 6), 0, 0, 0]
            })
            await initAndAddPool(
                fixture,
                pool,
                baseToken.address,
                encodePriceSqrt("151.373306858723226652", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                10000,
                // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                getMaxTickRange(),
            )

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: 0,
                quote: parseUnits("9999.999999", await baseToken.decimals()),
                lowerTick: 50000,
                upperTick: 50200,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })
            const order = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50200)
            liquidity = order.liquidity
        })

        it("force error, over slippage protection when removing liquidity below price with only quote token", async () => {
            await expect(
                clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50200,
                    liquidity,
                    minBase: 0,
                    minQuote: parseUnits("10001"),
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.revertedWith("CH_PSCF")
        })
    })
})
