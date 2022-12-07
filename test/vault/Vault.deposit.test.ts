import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouseConfig, CollateralManager, TestERC20, TestWETH9, UniswapV3Pool, Vault } from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"

describe("Vault deposit test", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20
    let weth: TestERC20
    let wbtc: TestERC20
    let wethPriceFeedDispatcher: MockContract
    let clearingHouseConfig: ClearingHouseConfig
    let collateralManager: CollateralManager
    let pool: UniswapV3Pool
    let usdcDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        vault = fixture.vault
        usdc = fixture.USDC
        weth = fixture.WETH
        wbtc = fixture.WBTC
        wethPriceFeedDispatcher = fixture.mockedWethPriceFeedDispatcher
        clearingHouseConfig = fixture.clearingHouseConfig
        collateralManager = fixture.collateralManager
        pool = fixture.pool
        fixture = fixture

        usdcDecimals = await usdc.decimals()
        const amount = parseUnits("1000", usdcDecimals)
        await usdc.mint(alice.address, amount)

        await usdc.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
        await weth.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
        await wbtc.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
        await weth.connect(bob).approve(vault.address, ethers.constants.MaxUint256)
        await wbtc.connect(bob).approve(vault.address, ethers.constants.MaxUint256)
    })

    describe("settlement token", async () => {
        let usdcDecimals

        beforeEach(async () => {
            usdcDecimals = await usdc.decimals()
        })

        it("deposit settlement token", async () => {
            const amount = parseUnits("100", usdcDecimals)

            // check event has been sent
            await expect(vault.connect(alice).deposit(usdc.address, amount))
                .to.emit(vault, "Deposited")
                .withArgs(usdc.address, alice.address, amount)

            // reduce alice balance
            expect(await usdc.balanceOf(alice.address)).to.eq(parseUnits("900", usdcDecimals))

            // increase vault balance
            expect(await usdc.balanceOf(vault.address)).to.eq(amount)

            // update sender's balance
            expect(await vault.getBalance(alice.address)).to.eq(amount)
        })

        it("deposit settlement token for others", async () => {
            const amount = parseUnits("100", usdcDecimals)

            await expect(vault.connect(alice).depositFor(bob.address, usdc.address, amount))
                .to.emit(vault, "Deposited")
                .withArgs(usdc.address, bob.address, amount)

            // reduce alice balance
            expect(await usdc.balanceOf(alice.address)).to.eq(parseUnits("900", usdcDecimals))

            // alice's vault balance not changed
            expect(await vault.getBalance(alice.address)).to.be.eq(parseUnits("0", await usdc.decimals()))

            // increase vault balance
            expect(await usdc.balanceOf(vault.address)).to.eq(amount)

            // update bob's balance
            expect(await vault.getBalance(bob.address)).to.eq(amount)

            // bob's usdc balance not changed
            expect(await usdc.balanceOf(bob.address)).to.be.eq("0")
        })

        it("should be able to deposit for alice herself", async () => {
            const amount = parseUnits("100", await usdc.decimals())
            await vault.connect(alice).depositFor(alice.address, usdc.address, amount)

            const aliceBalance = await vault.getBalance(alice.address)
            const aliceUsdcBalanceAfter = await usdc.balanceOf(alice.address)

            // reduce alice's usdc balance
            expect(aliceUsdcBalanceAfter).to.be.eq(parseUnits("900", await usdc.decimals()))

            // increase alice's vault balance
            expect(aliceBalance).to.be.eq(amount)

            // increase vault balance
            expect(await usdc.balanceOf(vault.address)).to.eq(parseUnits("100", await usdc.decimals()))
        })

        it("force error, not enough balance", async () => {
            const amount = parseUnits("1100", await usdc.decimals())
            await expect(vault.connect(alice).deposit(usdc.address, amount)).to.be.revertedWith(
                "ERC20: transfer amount exceeds balance",
            )
            await expect(vault.connect(alice).depositFor(bob.address, usdc.address, amount)).to.be.revertedWith(
                "ERC20: transfer amount exceeds balance",
            )
        })

        it("force error, inconsistent vault balance with deflationary token", async () => {
            usdc.setTransferFeeRatio(50)
            await expect(
                vault.connect(alice).deposit(usdc.address, parseUnits("100", usdcDecimals)),
            ).to.be.revertedWith("V_IBA")
            usdc.setTransferFeeRatio(0)
        })

        it("force error, deposit for zero address", async () => {
            const amount = parseUnits("1000", await usdc.decimals())
            await expect(
                vault.connect(alice).depositFor(ethers.constants.AddressZero, usdc.address, amount),
            ).to.be.revertedWith("V_DFZA")
        })

        it("force error, zero amount", async () => {
            await expect(vault.connect(alice).deposit(usdc.address, "0")).to.be.revertedWith("V_ZA")
            await expect(vault.connect(alice).depositFor(bob.address, usdc.address, "0")).to.be.revertedWith("V_ZA")
        })

        describe("settlement token balance cap", async () => {
            beforeEach(async () => {
                await clearingHouseConfig.setSettlementTokenBalanceCap(100)
            })

            it("force error, when it's over settlementTokenBalanceCap", async () => {
                await expect(vault.connect(alice).deposit(usdc.address, 101)).to.be.revertedWith("V_GTSTBC")
            })

            it("force error, when the the total balance is over cap", async () => {
                await expect(vault.connect(alice).deposit(usdc.address, 100)).not.be.reverted
                await expect(vault.connect(alice).deposit(usdc.address, 1)).to.be.revertedWith("V_GTSTBC")
            })

            it("can deposit if balanceOf(vault) <= settlementTokenBalanceCap after deposited", async () => {
                await expect(vault.connect(alice).deposit(usdc.address, 99)).not.be.reverted
            })

            it("force error, cannot deposit when settlementTokenBalanceCap == 0", async () => {
                await clearingHouseConfig.setSettlementTokenBalanceCap(0)
                await expect(vault.connect(alice).deposit(usdc.address, 1)).to.be.revertedWith("V_GTSTBC")
                await expect(vault.connect(alice).deposit(usdc.address, 101)).to.be.revertedWith("V_GTSTBC")
            })
        })
    })

    describe("non-settlement token", async () => {
        let wbtcDecimals: number
        let weth9: TestWETH9
        beforeEach(async () => {
            const weth9Factory = await ethers.getContractFactory("TestWETH9")
            weth9 = (await weth9Factory.deploy()) as TestWETH9

            await collateralManager.addCollateral(weth9.address, {
                priceFeed: wethPriceFeedDispatcher.address,
                collateralRatio: (0.7e6).toString(),
                discountRatio: (0.1e6).toString(),
                depositCap: parseEther("1000"),
            })
            await vault.setWETH9(weth9.address)

            await weth9.connect(alice).deposit({ value: parseEther("300") })
            await weth9.connect(bob).deposit({ value: parseEther("300") })
            await weth9.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
            await weth9.connect(bob).approve(vault.address, ethers.constants.MaxUint256)

            wbtcDecimals = await wbtc.decimals()
            await wbtc.mint(alice.address, parseUnits("2000", wbtcDecimals))
            await wbtc.mint(bob.address, parseUnits("2000", wbtcDecimals))
            await wbtc.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
            await wbtc.connect(bob).approve(vault.address, ethers.constants.MaxUint256)
        })

        it("deposit non-settlement token", async () => {
            expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([])
            expect(await vault.getCollateralTokens(bob.address)).to.be.deep.eq([])

            await expect(vault.connect(alice).deposit(weth9.address, parseEther("100")))
                .to.emit(vault, "Deposited")
                .withArgs(weth9.address, alice.address, parseEther("100"))

            expect(await weth9.balanceOf(alice.address)).to.eq(parseEther("200"))
            expect(await weth9.balanceOf(vault.address)).to.eq(parseEther("100"))
            expect(await vault.getBalanceByToken(alice.address, weth9.address)).to.eq(parseEther("100"))

            await expect(vault.connect(alice).depositFor(bob.address, wbtc.address, parseUnits("100", wbtcDecimals)))
                .to.emit(vault, "Deposited")
                .withArgs(wbtc.address, bob.address, parseUnits("100", wbtcDecimals))

            expect(await wbtc.balanceOf(alice.address)).to.eq(parseUnits("1900", wbtcDecimals))
            expect(await wbtc.balanceOf(vault.address)).to.eq(parseUnits("100", wbtcDecimals))
            expect(await vault.getBalanceByToken(bob.address, wbtc.address)).to.eq(parseUnits("100", wbtcDecimals))

            // register collateral tokens
            expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([weth9.address])
            expect(await vault.getCollateralTokens(bob.address)).to.be.deep.eq([wbtc.address])
        })

        it("deposit ETH", async () => {
            expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([])
            expect(await vault.getCollateralTokens(bob.address)).to.be.deep.eq([])

            const aliceETHBalanceBefore = await alice.getBalance()

            const tx1 = await vault.connect(alice).depositEther({ value: parseEther("100") })
            await expect(tx1).to.emit(vault, "Deposited").withArgs(weth9.address, alice.address, parseEther("100"))

            const tx2 = await vault.connect(alice).depositEtherFor(bob.address, { value: parseEther("100") })
            await expect(tx2).to.emit(vault, "Deposited").withArgs(weth9.address, bob.address, parseEther("100"))

            expect(await weth9.balanceOf(alice.address)).to.eq(parseEther("300"))
            expect(await weth9.balanceOf(bob.address)).to.eq(parseEther("300"))
            expect(await weth9.balanceOf(vault.address)).to.eq(parseEther("200"))

            expect(await vault.getBalanceByToken(alice.address, weth9.address)).to.eq(parseEther("100"))
            expect(await vault.getBalanceByToken(bob.address, weth9.address)).to.eq(parseEther("100"))

            const tx1Receipt = await tx1.wait()
            const tx2Receipt = await tx2.wait()
            const totalGasUsed = tx1Receipt.gasUsed.mul(tx1.gasPrice).add(tx2Receipt.gasUsed.mul(tx2.gasPrice))
            const aliceETHBalanceAfter = await alice.getBalance()
            expect(aliceETHBalanceBefore.sub(aliceETHBalanceAfter)).to.eq(parseEther("200").add(totalGasUsed))

            // 600 (originally) + 100 (alice) + 100 (bob) = 800
            expect(await ethers.provider.getBalance(weth9.address)).to.be.eq(parseEther("800"))
            expect(await ethers.provider.getBalance(vault.address)).to.be.eq(parseEther("0"))

            expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([weth9.address])
            expect(await vault.getCollateralTokens(bob.address)).to.be.deep.eq([weth9.address])
        })

        it("deposit for oneself", async () => {
            const aliceETHBalanceBefore = await alice.getBalance()

            const tx1 = await vault
                .connect(alice)
                .depositFor(alice.address, wbtc.address, parseUnits("100", wbtcDecimals))
            await expect(tx1)
                .to.emit(vault, "Deposited")
                .withArgs(wbtc.address, alice.address, parseUnits("100", wbtcDecimals))

            const tx2 = await vault.connect(alice).depositEtherFor(alice.address, { value: parseEther("100") })
            await expect(tx2).to.emit(vault, "Deposited").withArgs(weth9.address, alice.address, parseEther("100"))

            expect(await weth9.balanceOf(alice.address)).to.eq(parseEther("300"))
            expect(await weth9.balanceOf(vault.address)).to.eq(parseEther("100"))
            expect(await vault.getBalanceByToken(alice.address, weth9.address)).to.eq(parseEther("100"))

            const tx1Receipt = await tx1.wait()
            const tx2Receipt = await tx2.wait()
            const totalGasUsed = tx1Receipt.gasUsed.mul(tx1.gasPrice).add(tx2Receipt.gasUsed.mul(tx2.gasPrice))
            const aliceETHBalanceAfter = await alice.getBalance()
            expect(aliceETHBalanceBefore.sub(aliceETHBalanceAfter)).to.be.eq(parseEther("100").add(totalGasUsed))

            expect(await wbtc.balanceOf(alice.address)).to.eq(parseUnits("1900", wbtcDecimals))
            expect(await wbtc.balanceOf(vault.address)).to.eq(parseUnits("100", wbtcDecimals))
            expect(await vault.getBalanceByToken(alice.address, wbtc.address)).to.eq(parseUnits("100", wbtcDecimals))
        })

        it("force error, deposit token is not a collateral token", async () => {
            await expect(vault.connect(alice).deposit(pool.address, parseEther("100"))).to.be.revertedWith("V_OSCT")
            await expect(
                vault.connect(alice).depositFor(bob.address, pool.address, parseEther("100")),
            ).to.be.revertedWith("V_OSCT")

            // WETH is set with a wrong address
            await vault.setWETH9(pool.address)
            await expect(vault.connect(alice).depositEther({ value: parseEther("100") })).to.be.revertedWith("V_WINAC")
        })

        it("force error, max collateral tokens per account exceeded", async () => {
            await collateralManager.setMaxCollateralTokensPerAccount(1)

            await expect(vault.connect(alice).depositEther({ value: parseEther("100") }))
                .to.emit(vault, "Deposited")
                .withArgs(weth9.address, alice.address, parseEther("100"))

            await expect(
                vault.connect(alice).deposit(wbtc.address, parseUnits("100", wbtcDecimals)),
            ).to.be.revertedWith("V_CTNE")
        })

        it("force error, non-settlement amount exceeds deposit cap", async () => {
            await collateralManager.setDepositCap(weth9.address, parseEther("100"))

            await expect(vault.connect(alice).deposit(weth9.address, parseEther("100"))).to.emit(vault, "Deposited")

            await expect(vault.connect(alice).deposit(weth9.address, parseEther("1"))).to.be.revertedWith("V_GTDC")
            await expect(vault.connect(alice).depositEther({ value: parseEther("1") })).to.be.revertedWith("V_GTDC")
            await expect(
                vault.connect(alice).depositEtherFor(bob.address, { value: parseEther("1") }),
            ).to.be.revertedWith("V_GTDC")
        })

        it("force error, cannot deposit when non-settlement token deposit cap == 0", async () => {
            await collateralManager.setDepositCap(weth9.address, 0)

            await expect(vault.connect(alice).deposit(weth9.address, parseEther("100"))).to.be.revertedWith("V_GTDC")
            await expect(vault.connect(alice).depositEther({ value: parseEther("100") })).to.be.revertedWith("V_GTDC")
            await expect(
                vault.connect(alice).depositEtherFor(bob.address, { value: parseEther("100") }),
            ).to.be.revertedWith("V_GTDC")
        })

        it("force error, zero amount", async () => {
            await expect(vault.connect(alice).deposit(weth9.address, parseEther("0"))).to.be.revertedWith("V_ZA")
            await expect(vault.connect(alice).depositEther()).to.be.revertedWith("V_ZA")
            await expect(vault.connect(alice).depositEtherFor(bob.address)).to.be.revertedWith("V_ZA")
        })

        it("force error, zero address", async () => {
            await expect(
                vault.connect(alice).depositFor(ethers.constants.AddressZero, weth9.address, parseEther("10")),
            ).to.be.revertedWith("V_DFZA")
            await expect(
                vault.connect(alice).depositEtherFor(ethers.constants.AddressZero, { value: parseEther("10") }),
            ).to.be.revertedWith("V_DFZA")
        })
    })
})
