import { expect } from "chai"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse.swap", () => {
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

    describe("swap", () => {
        beforeEach(async () => {
            await collateral.mint(alice.address, toWei(10))
            await collateral.connect(alice).approve(clearingHouse.address, toWei(10))
            await clearingHouse.connect(alice).deposit(toWei(10))
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(10))
            await clearingHouse.connect(alice).mint(quoteToken.address, toWei(10))
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(9))
        })

        it("# swap should update TokenInfos", async () => {
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
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei(0.01),
                sqrtPriceLimitX96: 0,
            })
            expect(await clearingHouse.getTokenInfo(bob.address, baseToken.address)).to.deep.eq([
                toWei(1 - 0.01), // available
                toWei(1), // debt
            ])
            const { available: bobQuoteAvailable } = await clearingHouse.getTokenInfo(bob.address, quoteToken.address)
            expect(bobQuoteAvailable.gt(toWei(0))).to.be.true
        })
    })
})
