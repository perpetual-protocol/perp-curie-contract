import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse.swap", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number

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

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)
    })

    beforeEach(async () => {
        // prepare maker alice
        await collateral.mint(alice.address, parseUnits("1000", collateralDecimals))
        await deposit(alice, vault, 1000, collateral)
        await clearingHouse.connect(alice).mint(baseToken.address, parseEther("100"))
        await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("1000"))
        await pool.initialize(encodePriceSqrt("10", "1"))
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("1000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
    })

    describe("increase short position (B2Q)", () => {
        let bobQuoteAvailableBefore
        let initOpenNotional
        beforeEach(async () => {
            await collateral.mint(bob.address, parseUnits("100", collateralDecimals))
            await deposit(bob, vault, 100, collateral)

            await clearingHouse.connect(bob).mint(baseToken.address, parseEther("1"))
            bobQuoteAvailableBefore = (await clearingHouse.getTokenInfo(bob.address, quoteToken.address)).available
            await clearingHouse.connect(bob).swap({
                // sell 1 base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
            })
            initOpenNotional = await clearingHouse.getOpenNotional(bob.address, baseToken.address)
        })

        it("openNotional++", async () => {
            const bobQuoteAvailableAfter = (await clearingHouse.getTokenInfo(bob.address, quoteToken.address)).available
            const bobQuoteSpent = bobQuoteAvailableAfter.sub(bobQuoteAvailableBefore)
            expect(initOpenNotional).to.deep.eq(bobQuoteSpent)
        })

        it("base available--", async () => {
            expect(await clearingHouse.getTokenInfo(bob.address, baseToken.address)).to.deep.eq([
                parseEther("0"), // available
                parseEther("1"), // debt
            ])
        })

        it("quote available++", async () => {
            const { available: bobQuoteAvailable } = await clearingHouse.getTokenInfo(bob.address, quoteToken.address)
            expect(bobQuoteAvailable.gt(0)).to.be.true
        })

        it("realizedPnl remains", async () => {
            const pnl = await clearingHouse.getOwedRealizedPnl(bob.address)
            expect(pnl).eq(0)
        })

        describe("reduce 25% position (exactInput), profit", () => {
            beforeEach(async () => {
                // another trader carol sell base, price down
                await collateral.mint(carol.address, parseUnits("100", collateralDecimals))
                await deposit(carol, vault, 100, collateral)
                await clearingHouse.connect(carol).mint(baseToken.address, parseEther("10"))
                await clearingHouse.connect(carol).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: parseEther("10"),
                    sqrtPriceLimitX96: 0,
                })

                // bob reduce 25% position
                await clearingHouse.connect(bob).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: false, // quote to base
                    isExactInput: false, // is exact output (base)
                    amount: parseEther("0.25"),
                    sqrtPriceLimitX96: 0,
                })
            })

            it("openNotionalAbs--", async () => {
                const openNotional = await clearingHouse.getOpenNotional(bob.address, baseToken.address)
                // expect openNotion are same signed
                expect(openNotional.mul(initOpenNotional).gt(0))
                expect(openNotional.abs().lt(initOpenNotional.abs())).be.true
            })

            it("realizedPnl++", async () => {
                const pnl = await clearingHouse.getOwedRealizedPnl(bob.address)
                expect(pnl.gt(0)).be.true
            })
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

    describe("increase long position (Q2B)", () => {
        let bobQuoteAvailableBefore
        let initOpenNotional
        beforeEach(async () => {
            await collateral.mint(bob.address, parseUnits("25", collateralDecimals))
            await deposit(bob, vault, 25, collateral)

            await clearingHouse.connect(bob).mint(quoteToken.address, parseEther("250"))
            bobQuoteAvailableBefore = (await clearingHouse.getTokenInfo(bob.address, quoteToken.address)).available
            await clearingHouse.connect(bob).swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true, // exact quote
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
            })
            initOpenNotional = await clearingHouse.getOpenNotional(bob.address, baseToken.address)
        })

        it("openNotional++", async () => {
            const bobQuoteAvailableAfter = (await clearingHouse.getTokenInfo(bob.address, quoteToken.address)).available
            const bobQuoteSpent = bobQuoteAvailableAfter.sub(bobQuoteAvailableBefore)
            expect(initOpenNotional).to.deep.eq(bobQuoteSpent)
        })

        it("base available++", async () => {
            const baseTokenInfo = await clearingHouse.getTokenInfo(bob.address, baseToken.address)
            expect(baseTokenInfo.available.gt(0)).be.true
            expect(baseTokenInfo.debt).to.deep.eq(parseEther("0"))
        })

        it("quote available--", async () => {
            const quoteTokenInfo = await clearingHouse.getTokenInfo(bob.address, quoteToken.address)
            expect(quoteTokenInfo.available).to.deep.eq(parseEther("0"))
            expect(quoteTokenInfo.debt).to.deep.eq(parseEther("250"))
        })

        it("realizedPnl remains", async () => {
            const pnl = await clearingHouse.getOwedRealizedPnl(bob.address)
            expect(pnl).eq(0)
        })

        describe("reduce 75% position (exactOutput), loss", () => {
            beforeEach(async () => {
                // another trader carol sell base, price down
                await collateral.mint(carol.address, parseUnits("10000", collateralDecimals))
                await deposit(carol, vault, 10000, collateral)
                await clearingHouse.connect(carol).mint(baseToken.address, parseEther("10000"))
                await clearingHouse.connect(carol).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false, // exact output (quote)
                    amount: parseEther("50"),
                    sqrtPriceLimitX96: 0,
                })

                const bobPosSize = await clearingHouse.getPositionSize(bob.address, baseToken.address)
                const partial = bobPosSize.div(4).mul(3)
                // bob reduce 75% position
                await clearingHouse.connect(bob).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true, // is exact input (base)
                    amount: partial,
                    sqrtPriceLimitX96: 0,
                })
            })

            it("openNotional--", async () => {
                const openNotional = await clearingHouse.getOpenNotional(bob.address, baseToken.address)
                // expect openNotion are same signed
                expect(openNotional.mul(initOpenNotional).gt(0))
                expect(openNotional.abs().lt(initOpenNotional.abs())).be.true
            })

            // problem: it might increase the realized pnl when reducing position
            it("realizedPnl--", async () => {
                const pnl = await clearingHouse.getOwedRealizedPnl(bob.address)
                expect(pnl.lt(0)).be.true
            })
        })
    })
})
