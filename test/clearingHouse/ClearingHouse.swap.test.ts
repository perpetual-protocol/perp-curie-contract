import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { toWei } from "../helper/number"
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
        await collateral.mint(alice.address, toWei(10, collateralDecimals))

        await deposit(alice, vault, 10, collateral)
        expect(await clearingHouse.getBuyingPower(alice.address)).to.eq(toWei(10, collateralDecimals))
        await clearingHouse.connect(alice).mint(quoteToken.address, toWei(10))
        expect(await clearingHouse.getBuyingPower(alice.address)).to.eq(toWei(9, collateralDecimals))
    })

    it("update TokenInfos", async () => {
        await pool.initialize(encodePriceSqrt("154.4310961", "1"))

        const { available: previousAvailable } = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)

        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: toWei(0),
            quote: toWei(10),
            lowerTick: 50200,
            upperTick: 50400,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        await collateral.mint(bob.address, toWei(100, collateralDecimals))
        await deposit(bob, vault, 100, collateral)

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
