import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { TestClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse addLiquidity slippage", () => {
    const [admin, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let baseAmount: BigNumber
    let quoteAmount: BigNumber

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        baseAmount = parseUnits("100", await baseToken.decimals())
        quoteAmount = parseUnits("10000", await quoteToken.decimals())

        // mint
        collateral.mint(admin.address, parseEther("10000"))

        // prepare collateral for alice
        const amount = parseUnits("1000", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 1000, collateral)
    })

    describe("# addLiquidity failed at tick 50199", () => {
        beforeEach(async () => {
            await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50200 (1.0001 ^ 50200 = 151.373306858723226651)
            // add pool after it's initialized
            await clearingHouse.addPool(baseToken.address, 10000)

            // mint
            await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
            await clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)
        })

        it("force error, over slippage protection when adding liquidity above price with only base", async () => {
            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("10", await baseToken.decimals()),
                    quote: 0,
                    lowerTick: 50200,
                    upperTick: 50400,
                    minBase: parseEther("11"),
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.revertedWith("CH_PSC")
        })

        it("force error, over deadline", async () => {
            const now = (await waffle.provider.getBlock("latest")).timestamp
            await clearingHouse.setBlockTimestamp(now + 1)

            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("10", await baseToken.decimals()),
                    quote: 0,
                    lowerTick: 50200,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    deadline: now,
                }),
            ).to.revertedWith("V_TE")
        })
    })

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1155466937
    describe("# addLiquidity failed at tick 50200", () => {
        beforeEach(async () => {
            await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001 ^ 50200 = 151.373306858723226652)
            // add pool after it's initialized
            await clearingHouse.addPool(baseToken.address, 10000)

            // mint
            await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
            await clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)
        })

        it("force error, over slippage protection when adding liquidity below price with only quote token", async () => {
            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: 0,
                    quote: parseEther("10000"),
                    lowerTick: 50000,
                    upperTick: 50200,
                    minBase: 0,
                    minQuote: parseEther("10001"),
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.revertedWith("CH_PSC")
        })

        it("force error, over slippage protection when adding liquidity within price with both quote and base", async () => {
            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("1"),
                    quote: parseEther("10000"),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: parseEther("2"),
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.revertedWith("CH_PSC")
            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("1"),
                    quote: parseEther("10000"),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: parseEther("10001"),
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.revertedWith("CH_PSC")
            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("1"),
                    quote: parseEther("10000"),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: parseEther("2"),
                    minQuote: parseEther("10001"),
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.revertedWith("CH_PSC")
        })
    })
})
