import { expect } from "chai"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { toWei } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool

        // mint
        collateral.mint(admin.address, toWei(10000))

        // prepare collateral for alice
        const amount = toWei(1000, await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 1000, collateral)

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)

        // mint
        const baseAmount = toWei(100, await baseToken.decimals())
        const quoteAmount = toWei(10000, await quoteToken.decimals())
        await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
        await clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)
    })

    describe("# addLiquidity failed at tick 50199, over slippage protection", () => {
        beforeEach(async () => {
            await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50199 (1.0001^50199 = 151.373306858723226651)
        })

        it("over slippage protection when adding liquidity above price with only base", async () => {
            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: toWei(10, await baseToken.decimals()),
                    quote: 0,
                    lowerTick: 50200,
                    upperTick: 50400,
                    minBase: toWei(11),
                    minQuote: 0,
                }),
            ).to.revertedWith("CH_PSC")
        })
    })

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1155466937
    describe("# addLiquidity failed at tick 50200, over slippage protection", () => {
        beforeEach(async () => {
            await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
        })

        it("over slippage protection when adding liquidity below price with only quote token", async () => {
            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: 0,
                    quote: toWei(10000),
                    lowerTick: 50000,
                    upperTick: 50200,
                    minBase: 0,
                    minQuote: toWei(10001),
                }),
            ).to.revertedWith("CH_PSC")
        })

        it("over slippage protection when adding liquidity within price with both quote and base", async () => {
            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: toWei(1),
                    quote: toWei(10000),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: toWei(2),
                    minQuote: 0,
                }),
            ).to.revertedWith("CH_PSC")
            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: toWei(1),
                    quote: toWei(10000),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: toWei(10001),
                }),
            ).to.revertedWith("CH_PSC")
            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: toWei(1),
                    quote: toWei(10000),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: toWei(2),
                    minQuote: toWei(10001),
                }),
            ).to.revertedWith("CH_PSC")
        })
    })
})
