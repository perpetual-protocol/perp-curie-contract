import { defaultAbiCoder } from "@ethersproject/abi"
import { expect } from "chai"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { encodePriceSqrt } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(true))
        clearingHouse = _clearingHouseFixture.clearingHouse
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
    })

    describe("# deposit", () => {
        const aliceInitCollateralBalance = 1000

        beforeEach(async () => {
            // mint
            collateral.mint(admin.address, toWei(10000))

            const amount = toWei(aliceInitCollateralBalance, await collateral.decimals())
            await collateral.transfer(alice.address, amount)
            await collateral.connect(alice).approve(clearingHouse.address, amount)
        })

        // @SAMPLE - deposit
        it("alice deposit and sends an event", async () => {
            const amount = toWei(100, await collateral.decimals())

            // check event has been sent
            await expect(clearingHouse.connect(alice).deposit(amount))
                .to.emit(clearingHouse, "Deposited")
                .withArgs(collateral.address, alice.address, amount)

            // check collateral status
            expect(await clearingHouse.getCollateral(alice.address)).to.eq(amount)

            // check alice balance
            expect(await collateral.balanceOf(alice.address)).to.eq(toWei(900, await collateral.decimals()))
        })

        // TODO should we test against potential attack using EIP777?
    })

    describe("# mint", () => {
        const aliceInitCollateralBalance = 1000

        beforeEach(async () => {
            // mint
            collateral.mint(admin.address, toWei(10000))

            // prepare collateral
            const amount = toWei(aliceInitCollateralBalance, await collateral.decimals())
            await collateral.transfer(alice.address, amount)
            await collateral.connect(alice).approve(clearingHouse.address, amount)
            await clearingHouse.connect(alice).deposit(amount)

            // add pool
            await clearingHouse.addPool(baseToken.address, 10000)
        })

        it("alice mint quote and sends an event", async () => {
            // assume imRatio = 0.1
            // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
            const quoteAmount = toWei(10000, await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, 0, quoteAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(baseToken.address, quoteToken.address, 0, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await quoteToken.decimals()))
            // verify free collateral = 1000 - 10,000 * 0.1 = 0
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(0)
        })

        it("alice mint base and sends an event", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
            const baseAmount = toWei(100, await baseToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount, 0))
                .to.emit(clearingHouse, "Minted")
                .withArgs(baseToken.address, quoteToken.address, baseAmount, 0)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await baseToken.decimals()))
            // verify free collateral = 1,000 - 100 * 100 * 0.1 = 0
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(0)
        })

        it("alice mint base twice", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
            const baseAmount = toWei(50, await baseToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount, 0))
                .to.emit(clearingHouse, "Minted")
                .withArgs(baseToken.address, quoteToken.address, baseAmount, 0)
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount, 0))
                .to.emit(clearingHouse, "Minted")
                .withArgs(baseToken.address, quoteToken.address, baseAmount, 0)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await baseToken.decimals()))
            // verify free collateral = 1,000 - 100 * 100 * 0.1 = 0
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(0)
        })

        it("alice mint both and sends an event", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 100 base, 1,0000 quote
            const baseAmount = toWei(100, await baseToken.decimals())
            const quoteAmount = toWei(10000, await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount, quoteAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(baseToken.address, quoteToken.address, baseAmount, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await baseToken.decimals()))
            // verify free collateral = 1,000 - max(1000 * 10, 10,000) * 0.1 = 0
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(0)
        })

        it("alice mint equivalent base and quote", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 50 base, 5000 quote
            const baseAmount = toWei(50, await baseToken.decimals())
            const quoteAmount = toWei(5000, await quoteToken.decimals())
            await clearingHouse.connect(alice).mint(baseToken.address, baseAmount, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await baseToken.decimals()))
            // verify free collateral = 1,000 - max(500 * 10, 5,000) * 0.1 = 500
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(500, await baseToken.decimals()))
        })

        it("alice mint non-equivalent base and quote", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 50 base, 5000 quote
            const baseAmount = toWei(60, await baseToken.decimals())
            const quoteAmount = toWei(4000, await quoteToken.decimals())
            await clearingHouse.connect(alice).mint(baseToken.address, baseAmount, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await baseToken.decimals()))
            // verify free collateral = 1,000 - max(600 * 10, 4,000) * 0.1 = 400
            expect(await clearingHouse.getFreeCollateral(alice.address)).to.eq(toWei(400, await baseToken.decimals()))
        })

        it("registers each base token once at most", async () => {
            const connectedClearingHouse = clearingHouse.connect(alice)
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 10000 quote once and then mint 50 base twice
            const baseAmount = toWei(50, await baseToken.decimals())
            const quoteAmount = toWei(10000, await quoteToken.decimals())
            await connectedClearingHouse.mint(baseToken.address, 0, quoteAmount)
            await connectedClearingHouse.mint(baseToken.address, baseAmount, 0)
            await connectedClearingHouse.mint(baseToken.address, baseAmount, 0)

            expect(await clearingHouse.getAccountTokens(alice.address)).to.deep.eq([
                quoteToken.address,
                baseToken.address,
            ])
        })

        it("force error, alice mint too many quote", async () => {
            // alice collateral = 1000, freeCollateral = 10,000, mint 10,001 quote
            const quoteAmount = toWei(10001, await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, 0, quoteAmount)).to.be.revertedWith(
                "CH_NEAV",
            )
        })

        it("force error, alice mint too many base", async () => {
            // alice collateral = 1000, freeCollateral = 10,000, mint 10,001 quote
            const baseAmount = toWei(101, await baseToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount, 0)).to.be.revertedWith(
                "CH_NEAV",
            )
        })

        it("force error, alice mint without specifying amount", async () => {
            await expect(clearingHouse.connect(alice).mint(baseToken.address, 0, 0)).to.be.revertedWith("CH_II")
        })

        it("force error, alice mint base without specifying baseToken", async () => {
            const baseAmount = toWei(100, await baseToken.decimals())
            await expect(clearingHouse.connect(alice).mint(EMPTY_ADDRESS, baseAmount, 0)).to.be.revertedWith("CH_II")
        })

        it("force error, alice mint base without addPool first", async () => {
            const baseAmount = toWei(100, await baseToken.decimals())
            // collateral: just a random address
            await expect(clearingHouse.connect(alice).mint(collateral.address, baseAmount, 0)).to.be.revertedWith(
                "CH_II",
            )
        })
    })

    // simulation results:
    //   https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1155466937
    describe("# addLiquidity", () => {
        const aliceInitCollateralBalance = 1000

        describe("base0, quote1", () => {
            beforeEach(async () => {
                // mint
                collateral.mint(admin.address, toWei(10000))

                // prepare collateral
                const amount = toWei(aliceInitCollateralBalance, await collateral.decimals())
                await collateral.transfer(alice.address, amount)
                await collateral.connect(alice).approve(clearingHouse.address, amount)
                await clearingHouse.connect(alice).deposit(amount)

                // add pool
                await clearingHouse.addPool(baseToken.address, 10000)

                // mint
                const baseAmount = toWei(100, await baseToken.decimals())
                const quoteAmount = toWei(10000, await quoteToken.decimals())
                await clearingHouse.connect(alice).mint(baseToken.address, baseAmount, quoteAmount)
            })

            it("add liquidity below price with only quote token", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: toWei(10000, await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50200,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityAdded")
                    .withArgs(
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50200,
                        0,
                        toWei(10000, await quoteToken.decimals()),
                        "81689571696303801037492",
                        0,
                        0,
                    )

                // verify CH balance changes
                expect(await baseToken.balanceOf(clearingHouse.address)).to.eq(baseBefore)
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(10000, await quoteToken.decimals()),
                )
            })

            it("add liquidity below price with both tokens but expecting only quote token to be added", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(1, await quoteToken.decimals()),
                        quote: toWei(10000, await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50200,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityAdded")
                    .withArgs(
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50200,
                        0,
                        toWei(10000, await quoteToken.decimals()),
                        "81689571696303801037492",
                        0,
                        0,
                    )

                // verify CH balance changes
                expect(await baseToken.balanceOf(clearingHouse.address)).to.eq(baseBefore)
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(10000, await quoteToken.decimals()),
                )
            })

            it("add liquidity above price with only base token", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50199 (1.0001^50199 = 151.373306858723226651)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(100, await baseToken.decimals()),
                        quote: 0,
                        lowerTick: 50200,
                        upperTick: 50400,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityAdded")
                    .withArgs(
                        baseToken.address,
                        quoteToken.address,
                        50200,
                        50400,
                        toWei(100, await baseToken.decimals()),
                        0,
                        "123656206035422669342231",
                        0,
                        0,
                    )

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(100, await baseToken.decimals()),
                )
                expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(quoteBefore)
            })

            it("add liquidity above price with both tokens but expecting only base token to be added", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50199 (1.0001^50199 = 151.373306858723226651)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(100, await baseToken.decimals()),
                        quote: toWei(1, await baseToken.decimals()),
                        lowerTick: 50200,
                        upperTick: 50400,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityAdded")
                    .withArgs(
                        baseToken.address,
                        quoteToken.address,
                        50200,
                        50400,
                        toWei(100, await baseToken.decimals()),
                        0,
                        "123656206035422669342231",
                        0,
                        0,
                    )

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(100, await baseToken.decimals()),
                )
                expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(quoteBefore)
            })

            it("add liquidity with both tokens, over commit base", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei("100", await baseToken.decimals()),
                        quote: toWei(10000, await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50400,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityAdded")
                    .withArgs(
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50400,
                        toWei("66.061845430469484023", await baseToken.decimals()),
                        toWei(10000, await quoteToken.decimals()),
                        "81689571696303801018159",
                        0,
                        0,
                    )

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei("66.061845430469484023", await baseToken.decimals()),
                )
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(10000, await quoteToken.decimals()),
                )
            })

            it("add liquidity with both tokens, over commit quote", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 50 base and 10000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(50, await baseToken.decimals()),
                        quote: toWei(10000, await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50400,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityAdded")
                    .withArgs(
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50400,
                        toWei(50, await baseToken.decimals()),
                        "7568665342936161336147",
                        "61828103017711334685748",
                        0,
                        0,
                    )

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(50, await baseToken.decimals()),
                )
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                    "7568665342936161336147",
                )
            })

            it("force error, add nothing", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: 0,
                        lowerTick: 50000,
                        upperTick: 50200,
                    }),
                ).to.be.revertedWith("UB_ZIs")
            })

            it("force error, add base-only liquidity below price", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(1, await baseToken.decimals()),
                        quote: 0,
                        lowerTick: 50000,
                        upperTick: 50200,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            it("force error, add quote-only liquidity above price", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50199 (1.0001^50200 = 151.373306858723226651)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: toWei(1, await quoteToken.decimals()),
                        lowerTick: 50200,
                        upperTick: 50400,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            it("force error, add base-only liquidity in price", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(50, await baseToken.decimals()),
                        quote: 0,
                        lowerTick: 50000,
                        upperTick: 50400,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            it("force error, add quote-only liquidity in price", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: toWei(1, await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50400,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            it("force error, non-registered pool calls mint callback", async () => {
                const encodedData = defaultAbiCoder.encode(["address"], [baseToken.address])
                await expect(clearingHouse.uniswapV3MintCallback(123, 456, encodedData)).to.be.revertedWith("CH_NPOOL")
            })
        })

        describe("base1, quote0", () => {
            beforeEach(async () => {
                const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(false))
                clearingHouse = _clearingHouseFixture.clearingHouse
                collateral = _clearingHouseFixture.USDC
                baseToken = _clearingHouseFixture.baseToken
                quoteToken = _clearingHouseFixture.quoteToken
                pool = _clearingHouseFixture.pool

                // mint
                collateral.mint(admin.address, toWei(10000))

                // prepare collateral
                const amount = toWei(aliceInitCollateralBalance, await collateral.decimals())
                await collateral.transfer(alice.address, amount)
                await collateral.connect(alice).approve(clearingHouse.address, amount)
                await clearingHouse.connect(alice).deposit(amount)

                // add pool
                await clearingHouse.addPool(baseToken.address, 10000)

                // mint
                const baseAmount = toWei(100, await baseToken.decimals())
                const quoteAmount = toWei(10000, await quoteToken.decimals())
                await clearingHouse.connect(alice).mint(baseToken.address, baseAmount, quoteAmount)
            })

            it("add liquidity with both tokens", async () => {
                await pool.initialize(encodePriceSqrt("1", "151.373306858723226652")) // tick = -50200 (because base is token1 and quote is token0)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 66.06184541 base and 10000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei("66.061845430469484023", await baseToken.decimals()),
                        quote: toWei(10000, await quoteToken.decimals()),
                        lowerTick: 50000, // from CH's perspective, lowerTick & upperTick is still based on quote/base price, so the number is positive in our test case
                        upperTick: 50400,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityAdded")
                    .withArgs(
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50400,
                        toWei("66.061845430469484023", await baseToken.decimals()),
                        toWei(10000, await quoteToken.decimals()),
                        "81689571696303801018159",
                        0,
                        0,
                    )

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei("66.061845430469484023", await baseToken.decimals()),
                )
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(10000, await quoteToken.decimals()),
                )
            })
        })
    })
})
