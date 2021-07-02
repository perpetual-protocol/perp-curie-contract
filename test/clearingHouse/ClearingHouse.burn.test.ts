import { expect } from "chai"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse.burn", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool

        await clearingHouse.addPool(baseToken.address, "10000")
    })

    describe("burn quote when debt = 10", () => {
        beforeEach(async () => {
            // prepare collateral for alice
            await collateral.mint(alice.address, toWei(10))
            await collateral.connect(alice).approve(clearingHouse.address, toWei(10))
            await clearingHouse.connect(alice).deposit(toWei(10))
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(10))
            await clearingHouse.connect(alice).mint(quoteToken.address, toWei(10))
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(9))
        })

        it("# burn quote 10 when debt = 10, available = 10", async () => {
            expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                toWei(10), // available
                toWei(10), // debt
            ])

            await expect(clearingHouse.connect(alice).burn(quoteToken.address, toWei(10)))
                .to.emit(clearingHouse, "Burned")
                .withArgs(quoteToken.address, toWei(10))

            expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                toWei(0), // available
                toWei(0), // debt
            ])

            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(10))
        })

        it("# burn quote 10 when debt = 10, available >= 10", async () => {
            // P(50200) = 1.0001^50200 ~= 151.3733069
            await pool.initialize(encodePriceSqrt(151.3733069, 1))
            const lowerTick = 50000
            const upperTick = 50200

            // alice adds liquidity (quote only) under the current price
            const { available: aliceQuoteAvailableBefore } = await clearingHouse.getTokenInfo(
                alice.address,
                quoteToken.address,
            )

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: toWei(0),
                quote: toWei(10),
                lowerTick: lowerTick, // 148.3760629
                upperTick: upperTick, // 151.3733069
            })

            // prepare collateral for bob
            await collateral.mint(bob.address, toWei(100))
            await collateral.connect(bob).approve(clearingHouse.address, toWei(100))
            await clearingHouse.connect(bob).deposit(toWei(100))
            await clearingHouse.connect(bob).mint(baseToken.address, toWei(1))
            await clearingHouse.connect(bob).mint(quoteToken.address, toWei(100))

            // bob swaps base for quote (sell base), so alice receives base as fee
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei(0.01), // the amount of base to sell
                sqrtPriceLimitX96: 0,
            })

            // bob swaps quote for base (buy base), so alice receives quote as fee
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: toWei(0.01), // the amount of base to buy
                sqrtPriceLimitX96: encodePriceSqrt("155", "1"),
            })

            // alice removes 0 liquidity to collect fee
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick,
                upperTick: upperTick,
                liquidity: 0,
            })

            // alice removes liquidity
            const { liquidity } = await clearingHouse.getOpenOrder(
                alice.address,
                baseToken.address,
                lowerTick,
                upperTick,
            )
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick,
                upperTick: upperTick,
                liquidity: liquidity,
            })

            const { available: aliceQuoteAvailableAfter } = await clearingHouse.getTokenInfo(
                alice.address,
                quoteToken.address,
            )

            // contains fee
            expect(aliceQuoteAvailableAfter.gt(toWei(10))).to.be.true

            await expect(
                clearingHouse.connect(alice).burn(quoteToken.address, aliceQuoteAvailableAfter),
            ).to.be.revertedWith("CH_IA")

            // TODO: move to closePosition's tests
            // await expect(clearingHouse.connect(alice).burn(quoteToken.address, aliceQuoteAvailableAfter))
            //     .to.emit(clearingHouse, "Burned")
            //     .withArgs(quoteToken.address, toWei(10))

            // expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
            //     toWei(0), // available
            //     toWei(0), // debt
            // ])

            // const profit = aliceQuoteAvailableAfter.sub(aliceQuoteAvailableBefore)
            // expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(10).add(profit))
        })

        it("# burn quote 10 when debt = 10, available < 10", async () => {
            await pool.initialize(encodePriceSqrt("154.4310961", "1"))

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: toWei(0),
                quote: toWei(10),
                lowerTick: 50200,
                upperTick: 50400,
            })

            await collateral.mint(bob.address, toWei(100))
            await collateral.connect(bob).approve(clearingHouse.address, toWei(100))
            await clearingHouse.connect(bob).deposit(toWei(100))
            await clearingHouse.connect(bob).mint(baseToken.address, toWei(1))
            await clearingHouse.connect(bob).mint(quoteToken.address, toWei(100))

            await clearingHouse.connect(bob).swap({
                // sell base
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei(0.001),
                sqrtPriceLimitX96: 0,
            })

            const [liquidity, , , ,] = await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50200, 50400)
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: 50200,
                upperTick: 50400,
                liquidity: liquidity,
            })
            const { available: aliceQuoteAvailableAfter } = await clearingHouse.getTokenInfo(
                alice.address,
                quoteToken.address,
            )
            expect(aliceQuoteAvailableAfter.lt(toWei(10))).to.be.true
            await expect(clearingHouse.connect(alice).burn(quoteToken.address, aliceQuoteAvailableAfter))
                .to.emit(clearingHouse, "Burned")
                .withArgs(quoteToken.address, aliceQuoteAvailableAfter)

            const { available: aliceQuoteAvailableAfterAfterBurn, debt: aliceQuoteDebtAfterBurn } =
                await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
            expect(aliceQuoteAvailableAfterAfterBurn.eq(toWei(0))).to.be.true
            expect(aliceQuoteDebtAfterBurn.gt(toWei(0))).to.be.true
        })

        it("# force fail when the user has no vTokens", async () => {
            await expect(clearingHouse.connect(alice).burn(EMPTY_ADDRESS, 10)).to.be.revertedWith("CH_TNF")

            await expect(clearingHouse.connect(alice).burn(quoteToken.address, 0)).to.be.revertedWith("CH_IA")
        })
    })
})
