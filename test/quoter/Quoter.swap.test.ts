import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, Quoter, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { BaseQuoteOrdering, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"

describe("Quoter.swap", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let collateralDecimals: number
    let quoter: Quoter

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

        const quoterFactory = await ethers.getContractFactory("Quoter")
        quoter = (await quoterFactory.deploy()) as Quoter

        const lowerTick = 49000
        const upperTick = 51400

        // prepare maker alice
        await collateral.mint(alice.address, parseUnits("1000000", collateralDecimals))
        await deposit(alice, vault, 1000000, collateral)
        await clearingHouse.connect(alice).mint(baseToken.address, parseEther("10"))
        await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("1500"))
        await pool.initialize(encodePriceSqrt(151.3733069, 1))
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("10"),
            quote: parseEther("1500"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // deposit bob's collateral
        await collateral.mint(bob.address, parseUnits("50000", collateralDecimals))
        await deposit(bob, vault, 10000, collateral)
    })

    describe("quote Q2B with exact input", () => {
        it("returns same result with the CH.swap when liquidity is enough", async () => {
            const quoteResponse = await quoter.callStatic.swap({
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
            })

            await clearingHouse.connect(bob).mint(quoteToken.address, parseEther("250"))
            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
            })
            expect(quoteResponse).to.be.deep.eq(swapResponse)
        })

        it("returns same result with CH.swap when liquidity is not enough", async () => {
            const quoteResponse = await quoter.callStatic.swap({
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("30000"),
                sqrtPriceLimitX96: 0,
            })
            expect(quoteResponse.deltaAvailableQuote).to.be.lt(parseEther("30000"))

            await clearingHouse.connect(bob).mint(quoteToken.address, parseEther("30000"))
            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("30000"),
                sqrtPriceLimitX96: 0,
            })
            expect(quoteResponse).to.be.deep.eq(swapResponse)
        })
    })

    describe("quote Q2B with exact output", () => {
        it("returns same result with CH.swap when liquidity is enough", async () => {
            const quoteResponse = await quoter.callStatic.swap({
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: false,
                amount: parseEther("5"),
                sqrtPriceLimitX96: 0,
            })

            await clearingHouse.connect(bob).mint(quoteToken.address, parseEther("50000"))
            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: parseEther("5"),
                sqrtPriceLimitX96: 0,
            })
            expect(quoteResponse).to.be.deep.eq(swapResponse)
        })

        it("force error, unmatched output amount when liquidity is not enough", async () => {
            await expect(
                quoter.callStatic.swap({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    // buy base
                    isBaseToQuote: false,
                    isExactInput: false,
                    amount: parseEther("20"),
                    sqrtPriceLimitX96: 0,
                }),
            ).revertedWith("Q_UOA")

            await clearingHouse.connect(bob).mint(quoteToken.address, parseEther("50000"))
            await expect(
                clearingHouse.connect(bob).callStatic.swap({
                    // buy base
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    amount: parseEther("20"),
                    sqrtPriceLimitX96: 0,
                }),
            ).revertedWith("UB_UOA")
        })
    })

    describe("quote B2Q with exact input", () => {
        it("returns same result with CH.swap when liquidity is enough", async () => {
            const quoteResponse = await quoter.callStatic.swap({
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                // sell base
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("5"),
                sqrtPriceLimitX96: 0,
            })

            await clearingHouse.connect(bob).mint(baseToken.address, parseEther("5"))
            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                // sell base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("5"),
                sqrtPriceLimitX96: 0,
            })
            expect(quoteResponse).to.be.deep.eq(swapResponse)
        })

        it("returns same result with CH.swap when liquidity is not enough", async () => {
            const quoteResponse = await quoter.callStatic.swap({
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                // sell base
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("30"),
                sqrtPriceLimitX96: 0,
            })
            expect(quoteResponse.deltaAvailableBase).to.be.lt(parseEther("30"))

            await clearingHouse.connect(bob).mint(baseToken.address, parseEther("30"))
            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("30"),
                sqrtPriceLimitX96: 0,
            })
            expect(quoteResponse).to.be.deep.eq(swapResponse)
        })
    })

    describe("quote B2Q with exact output", () => {
        it("returns same result with CH.swap when liquidity is enough", async () => {
            const quoteResponse = await quoter.callStatic.swap({
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                // sell base
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })

            await clearingHouse.connect(bob).mint(baseToken.address, parseEther("20"))
            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                // sell base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })
            expect(quoteResponse).to.be.deep.eq(swapResponse)
        })

        it("force error, unmatched output amount when liquidity is not enough", async () => {
            await expect(
                quoter.callStatic.swap({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    // sell base
                    isBaseToQuote: true,
                    isExactInput: false,
                    amount: parseEther("3000"),
                    sqrtPriceLimitX96: 0,
                }),
            ).revertedWith("Q_UOA")

            await clearingHouse.connect(bob).mint(baseToken.address, parseEther("50"))
            await expect(
                clearingHouse.connect(bob).callStatic.swap({
                    // sell base
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    amount: parseEther("3000"),
                    sqrtPriceLimitX96: 0,
                }),
            ).revertedWith("UB_UOA")
        })
    })
})
