import { ethers } from "hardhat"
import { UniswapV3Factory } from "../typechain"

async function main() {
    const VUSD = await ethers.getContractFactory("TestERC20")
    const vUSD = await VUSD.deploy("VUSD", "VUSD")
    console.log("vUSD deployed to:", vUSD.address)

    // from deploy 01
    const usdcAddr = "0xf4D2c51c45d0F3Af87Bc597559Fb2703CDBe09fE"
    const quoteTokenAddr = vUSD.address
    const factoryAddr = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
    const ClearingHouse = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = await ClearingHouse.deploy(usdcAddr, quoteTokenAddr, factoryAddr)
    console.log("ClearingHouse deployed to:", clearingHouse.address)

    await vUSD.setMinter(clearingHouse.address)

    const VETH = await ethers.getContractFactory("TestERC20")
    const vETH = await VETH.deploy("VETH", "VETH")
    console.log("vETH deployed to:", vETH.address)
    await vETH.setMinter(clearingHouse.address)

    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const factory = factoryFactory.attach(factoryAddr) as UniswapV3Factory
    const tx = await factory.createPool(vUSD.address, vETH.address, "10000")
    const receipt = await tx.wait()
    const poolAddress = receipt.events?.[0].args?.pool as string

    console.log("vETH/vUSDC pool deployed to:", poolAddress)

    await clearingHouse.addPool(vETH.address, "10000")
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    })
