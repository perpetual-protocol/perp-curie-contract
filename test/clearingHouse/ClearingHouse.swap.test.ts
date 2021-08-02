import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse.swap", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        await clearingHouse.addPool(baseToken.address, "10000")
    })

    beforeEach(async () => {
        await collateral.mint(alice.address, parseUnits("1000", collateralDecimals))
        await deposit(alice, vault, 1000, collateral)
        await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("1000"))
    })

    describe.only("increase short position (B2Q)", () => {
        let bobQuoteAvailableBefore
        beforeEach(async () => {
            await pool.initialize(encodePriceSqrt("154.4310961", "1"))

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("1000"),
                lowerTick: 50200,
                upperTick: 50400,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            await collateral.mint(bob.address, parseUnits("100", collateralDecimals))
            await deposit(bob, vault, 100, collateral)

            await clearingHouse.connect(bob).mint(baseToken.address, parseEther("1"))
            bobQuoteAvailableBefore = (await clearingHouse.getTokenInfo(bob.address, quoteToken.address)).available
            await clearingHouse.connect(bob).swap({
                // sell base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
            })
        })

        it("openNotional++", async () => {
            const bobQuoteAvailableAfter = (await clearingHouse.getTokenInfo(bob.address, quoteToken.address)).available
            const bobQuoteSpent = bobQuoteAvailableAfter.sub(bobQuoteAvailableBefore)
            expect(await clearingHouse.getOpenNotional(bob.address, baseToken.address)).to.deep.eq(bobQuoteSpent)
        })

        it("base available--", async () => {
            expect(await clearingHouse.getTokenInfo(bob.address, baseToken.address)).to.deep.eq([
                parseEther("0"), // available
                parseEther("1"), // debt
            ])
        })

        it("quote available++", async () => {
            const { available: bobQuoteAvailable } = await clearingHouse.getTokenInfo(bob.address, quoteToken.address)
            expect(bobQuoteAvailable.gt(parseEther("0"))).to.be.true
        })

        it("realizedPnl remains", async () => {
            const pnl = await clearingHouse.getOwedRealizedPnl(bob.address)
            expect(pnl).eq(0)
        })

        describe("reduce 25% position, profit", () => {
            it("openNotional--")
            it("realizedPnl++")
            it("settle realizePnl to collateral (increased)")
        })

        describe("reduce 25% position, loss", () => {
            it("openNotional--")
            it("realizedPnl--")
            it("settle realizePnl to collateral (decreased)")
        })

        describe("reduce 100% position (close), profit", () => {
            it("clear openNotional")
            it("realizedPnl++")
            it("settle realizePnl to collateral (decreased)")
        })

        describe("reduce 100% position (close), loss", () => {
            it("clear openNotional")
            it("realizedPnl--")
            it("settle realizePnl to collateral (decreased)")
        })

        describe("swap reverse and larger amount, profit", () => {
            it("clear openNotional")
            it("realizedPnl++")
            it("settle realizePnl to collateral (decreased)")
        })

        describe("swap reverse and larger amount, loss", () => {
            it("clear openNotional")
            it("realizedPnl--")
            it("settle realizePnl to collateral (decreased)")
        })
    })

    describe.skip("increase long position (Q2B)", () => {})
})
