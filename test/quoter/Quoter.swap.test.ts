import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, Quoter, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { BaseQuoteOrdering, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { createQuoterFixture } from "./fixtures"

describe("Quoter.swap", () => {
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

        const _quoterFixture = await loadFixture(createQuoterFixture(clearingHouse.address))
        quoter = _quoterFixture.quoter

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

    // https://docs.google.com/spreadsheets/d/1fqUUUOofl2ovpW1Du5expYPc_aDI43lyGw50_55oE7k/edit#gid=879273398
    describe("quote Q2B, exact input", () => {
        let bobQuoteDelta
        let bobBaseDelta
        let quoteResponse

        beforeEach(async () => {
            quoteResponse = await quoter.callStatic.swap({
                pool: pool.address,
                baseToken: baseToken.address,
                quoteToken: quoteToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
            })

            console.log(quoteResponse.deltaAvailableBase.toString())
            console.log(quoteResponse.deltaAvailableQuote.toString())
            console.log(quoteResponse.exchangedPositionNotional.toString())
            console.log(quoteResponse.exchangedPositionSize.toString())
        })

        it("get correct quote reponse", async () => {
            await collateral.mint(bob.address, parseUnits("100", collateralDecimals))
            await deposit(bob, vault, 100, collateral)
            await clearingHouse.connect(bob).mint(quoteToken.address, parseEther("250"))
            const bobQuoteAvailableBefore = (await clearingHouse.getTokenInfo(bob.address, quoteToken.address))
                .available
            const bobBaseAvailableBefore = (await clearingHouse.getTokenInfo(bob.address, baseToken.address)).available

            await clearingHouse.connect(bob).swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
            })

            const bobQuoteAvailableAfter = (await clearingHouse.getTokenInfo(bob.address, quoteToken.address)).available
            const bobBaseAvailableAfter = (await clearingHouse.getTokenInfo(bob.address, baseToken.address)).available

            bobQuoteDelta = bobQuoteAvailableBefore.sub(bobQuoteAvailableAfter)
            bobBaseDelta = bobBaseAvailableAfter.sub(bobBaseAvailableBefore)

            expect(quoteResponse.deltaAvailableQuote).to.be.eq(bobQuoteDelta)
            expect(quoteResponse.deltaAvailableBase).to.be.eq(bobBaseDelta)
        })
    })
})
