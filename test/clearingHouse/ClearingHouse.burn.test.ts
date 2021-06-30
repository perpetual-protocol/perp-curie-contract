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

    describe("burn when debt = 10", () => {
        beforeEach(async () => {
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
            await pool.initialize(encodePriceSqrt("154.4310961", "1"))

            const { available: previousAvailable } = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)

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

            await clearingHouse.connect(bob).swap({
                // sell base
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei(0.01),
                sqrtPriceLimitX96: 0,
            })

            // FIXME: currently ch.swap() doesn't update TokenInfo
            const { available: bobQuoteAvailable } = await clearingHouse.getTokenInfo(bob.address, quoteToken.address)

            await clearingHouse.connect(bob).swap({
                // buy base
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: bobQuoteAvailable,
                sqrtPriceLimitX96: encodePriceSqrt("155", "1"),
            })

            const [liquidity, , , ,] = await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50200, 50400)
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: 50200,
                upperTick: 50400,
                liquidity: liquidity,
            })
            const { available } = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
            expect(available.gt(toWei(10))).to.be.true
            await expect(clearingHouse.connect(alice).burn(quoteToken.address, available))
                .to.emit(clearingHouse, "Burned")
                .withArgs(quoteToken.address, available)
            expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                toWei(0), // available
                toWei(0), // debt
                toWei(0), // fee FIXME alice should has fee
            ])

            const profit = available.sub(previousAvailable)
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(10).add(profit))
        })

        it("# burn quote 10 when debt = 10, available = 5", () => {})

        it("# force fail when the user has no vTokens", async () => {
            await expect(clearingHouse.connect(alice).burn(EMPTY_ADDRESS, 10)).to.be.revertedWith("CH_TNF")

            await expect(clearingHouse.connect(alice).burn(quoteToken.address, 0)).to.be.revertedWith("CH_IA")
        })
    })
})
