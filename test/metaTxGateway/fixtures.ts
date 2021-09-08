import { ethers } from "hardhat"
import { MetaTxGateway, TestMetaTxRecipient } from "../../typechain"

interface MetaTxGatewayFixture {
    metaTxGateway: MetaTxGateway
    metaTxRecipient: TestMetaTxRecipient
}

export function createMetaTxGatewayFixture(): () => Promise<MetaTxGatewayFixture> {
    return async (): Promise<MetaTxGatewayFixture> => {
        // deploy meta tx gateway
        const metaTxGatewayFactory = await ethers.getContractFactory("MetaTxGateway")
        const metaTxGateway = (await metaTxGatewayFactory.deploy()) as MetaTxGateway
        await metaTxGateway.initialize("Test", "1", 1)

        const metaTxGatewayRecipientFactory = await ethers.getContractFactory("TestMetaTxRecipient")
        const metaTxRecipient = (await metaTxGatewayRecipientFactory.deploy()) as TestMetaTxRecipient
        await metaTxRecipient.__TestMetaTxRecipient_init(metaTxGateway.address)

        return { metaTxGateway, metaTxRecipient }
    }
}
