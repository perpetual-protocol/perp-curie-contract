import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { toWei } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse with makers within same range", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    const million = toWei(1000000)
    const thousand = toWei(1000)
    const ten = toWei(10)
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

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)

        // mint
        collateral.mint(alice.address, million)
        collateral.mint(bob.address, million)
        collateral.mint(carol.address, million)

        await deposit(alice, vault, 1000000, collateral)
        await deposit(bob, vault, 1000000, collateral)
        await deposit(carol, vault, 1000000, collateral)

        // mint quote
        await clearingHouse.connect(alice).mint(quoteToken.address, thousand)
        await clearingHouse.connect(bob).mint(quoteToken.address, thousand)
        await clearingHouse.connect(carol).mint(quoteToken.address, thousand)

        // mint base
        await clearingHouse.connect(alice).mint(baseToken.address, ten)
        await clearingHouse.connect(bob).mint(baseToken.address, ten)
        await clearingHouse.connect(carol).mint(baseToken.address, ten)
    })

    describe("adding orders below current price", () => {
        it("get 50% of token if maker owns 50% of the liquidity", async () => {
            await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

            // alice bob as maker
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: 0,
                quote: thousand,
                lowerTick: 50000,
                upperTick: 50200,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
            await clearingHouse.connect(bob).addLiquidity({
                baseToken: baseToken.address,
                base: 0,
                quote: thousand,
                lowerTick: 50000,
                upperTick: 50200,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // carol take position in and out for generating fee for makers
            // generate 0.1 ETH fee and around 10-15 USD fee, shared by alice and bob
            await clearingHouse.connect(carol).swap({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: ten,
                sqrtPriceLimitX96: 0,
            })
            await clearingHouse.connect(carol).swap({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: ten,
                sqrtPriceLimitX96: encodePriceSqrt("200", "1"), // to avoid UB_IOA when no slippage protection
            })

            const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50200))
                .liquidity
            await expect(
                clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50200,
                    liquidity: liquidity,
                }),
            )
                .to.emit(clearingHouse, "LiquidityChanged")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    quoteToken.address,
                    50000,
                    50200,
                    0,
                    "-999999999999999999999", // ~= -1,000
                    liquidity.mul(-1).toString(),
                    "49999999999999999", // ~half of the total vETH fee
                    "7512656479464227918", // TODO need a spreadsheet to verify
                )
        })
    })
})
