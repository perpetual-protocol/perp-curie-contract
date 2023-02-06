pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CollateralManager } from "../../../contracts/CollateralManager.sol";
import { IClearingHouse } from "../../../contracts/interface/IClearingHouse.sol";
import { IVault } from "../../../contracts/interface/IVault.sol";

// start fork netwrok:
//  anvil -f OPTIMISM_MAINNET_RPC_URL --fork-block-number 72499964

// deploy ChainlinkPriceFeedV1R1.sol in forked network like below
// solhint-disable-next-line
// cast send  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --create 0x60c060405234801561001057600080fd5b50604051610b7a380380610b7a8339818101604052604081101561003357600080fd5b508051602091820151909161005a906001600160a01b0384169061059261010c821b17901c565b610095576040805162461bcd60e51b81526020600482015260076024820152664350465f414e4360c81b604482015290519081900360640190fd5b6100b1816001600160a01b031661010c60201b6105921760201c565b6100ee576040805162461bcd60e51b81526020600482015260096024820152684350465f5355464e4360b81b604482015290519081900360640190fd5b6001600160601b0319606092831b8116608052911b1660a052610112565b3b151590565b60805160601c60a05160601c610a21610159600039806102fc528061032552508061011852806101a252806101cc52806105a352806107a7528061086d5250610a216000f3fe608060405234801561001057600080fd5b50600436106100575760003560e01c8063313ce5671461005c5780633ad59dbc1461007a5780639a6fc8f51461009e578063a056076c146100dd578063e7572230146100e5575b600080fd5b610064610114565b6040805160ff9092168252519081900360200190f35b6100826101a0565b604080516001600160a01b039092168252519081900360200190f35b6100c4600480360360208110156100b457600080fd5b50356001600160501b03166101c4565b6040805192835260208301919091528051918290030190f35b6100826102fa565b610102600480360360208110156100fb57600080fd5b503561031e565b60408051918252519081900360200190f35b60007f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031663313ce5676040518163ffffffff1660e01b815260040160206040518083038186803b15801561016f57600080fd5b505afa158015610183573d6000803e3d6000fd5b505050506040513d602081101561019957600080fd5b5051905090565b7f000000000000000000000000000000000000000000000000000000000000000090565b6000806000807f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316639a6fc8f5866040518263ffffffff1660e01b815260040180826001600160501b0316815260200191505060a06040518083038186803b15801561023757600080fd5b505afa15801561024b573d6000803e3d6000fd5b505050506040513d60a081101561026157600080fd5b5060208101516060909101519092509050600082136102b0576040805162461bcd60e51b815260206004820152600660248201526504350465f49560d41b604482015290519081900360640190fd5b600081116102f0576040805162461bcd60e51b81526020600482015260086024820152674350465f52494e4360c01b604482015290519081900360640190fd5b9092509050915091565b7f000000000000000000000000000000000000000000000000000000000000000090565b60008060007f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031663feaf968c6040518163ffffffff1660e01b815260040160a06040518083038186803b15801561037c57600080fd5b505afa158015610390573d6000803e3d6000fd5b505050506040513d60a08110156103a657600080fd5b506020810151604090910151909250905081156103f3576040805162461bcd60e51b815260206004820152600660248201526510d41197d4d160d21b604482015290519081900360640190fd5b42819003610e108111610438576040805162461bcd60e51b81526020600482015260086024820152674350465f47504e4f60c01b604482015290519081900360640190fd5b6000806000610445610598565b925092509250600061045561066f565b90506000610463828b610673565b905089158061047957506001600160501b038516155b806104845750808311155b1561049957839850505050505050505061058d565b8260006104a68483610673565b905060006104b487836106d5565b905060005b6001600160501b0389166104f15782156104dc576104d78284610735565b6104de565b875b9c5050505050505050505050505061058d565b6001890398506000806105038b61079c565b92509250508681116105365761052d61052661051f888a610673565b84906106d5565b8590610925565b93505050610567565b6105408682610673565b925061054f61052683856106d5565b935061055b8584610925565b945080955050506104b9565b811561057c57610577828f610735565b61057e565b875b9c505050505050505050505050505b919050565b3b151590565b6000806000806000807f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031663feaf968c6040518163ffffffff1660e01b815260040160a06040518083038186803b1580156105fa57600080fd5b505afa15801561060e573d6000803e3d6000fd5b505050506040513d60a081101561062457600080fd5b50805160208201516060909201519196509350859250905060008212156106635761064e8361097f565b61065a6001840361079c565b90965090935090505b91945090915050909192565b4290565b6000828211156106ca576040805162461bcd60e51b815260206004820152601e60248201527f536166654d6174683a207375627472616374696f6e206f766572666c6f770000604482015290519081900360640190fd5b508082035b92915050565b6000826106e4575060006106cf565b828202828482816106f157fe5b041461072e5760405162461bcd60e51b81526004018080602001828103825260218152602001806109cb6021913960400191505060405180910390fd5b9392505050565b600080821161078b576040805162461bcd60e51b815260206004820152601a60248201527f536166654d6174683a206469766973696f6e206279207a65726f000000000000604482015290519081900360640190fd5b81838161079457fe5b049392505050565b6000806000806000807f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316639a6fc8f5886040518263ffffffff1660e01b815260040180826001600160501b0316815260200191505060a06040518083038186803b15801561081257600080fd5b505afa158015610826573d6000803e3d6000fd5b505050506040513d60a081101561083c57600080fd5b508051602082015160609092015190945090925090505b6000821215610918576108658361097f565b6001830392507f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316639a6fc8f5846040518263ffffffff1660e01b815260040180826001600160501b0316815260200191505060a06040518083038186803b1580156108d857600080fd5b505afa1580156108ec573d6000803e3d6000fd5b505050506040513d60a081101561090257600080fd5b5060208101516060909101519092509050610853565b9196909550909350915050565b60008282018381101561072e576040805162461bcd60e51b815260206004820152601b60248201527f536166654d6174683a206164646974696f6e206f766572666c6f770000000000604482015290519081900360640190fd5b6000816001600160501b0316116109c7576040805162461bcd60e51b8152602060048201526007602482015266086a08cbe9c8a960cb1b604482015290519081900360640190fd5b5056fe536166654d6174683a206d756c7469706c69636174696f6e206f766572666c6f77a26469706673582212209cdaab664f9db879b5e2a0cda7d770bde39aba2a0a144b3d179566942f5ca7d364736f6c6343000706003300000000000000000000000013e3Ee699D1909E989722E753853AE30b17e08c5000000000000000000000000371EAD81c9102C9BF4874A9075FFFf170F2Ee389
// contractAddress         0xa85233C63b9Ee964Add6F2cffe00Fd84eb32338f

interface IOptimismSequencerUptimeFeed {
    function updateStatus(bool status, uint64 timestamp) external;
}

interface IChainlinkPriceFeed {
    function getPrice(uint256 interval) external returns (uint256);
}

interface IL2CrossDomainMessenger {
    function relayMessage(
        address _target,
        address _sender,
        bytes memory _message,
        uint256 _messageNonce
    ) external;
}

interface IChainlinkAggregator {
    function latestRoundData()
        external
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

contract SequencerDownTest is Test {
    using stdStorage for StdStorage;

    address alice;

    address optimismSequencerUptimeFeed = 0x58218ea7422255EBE94e56b504035a784b7AA204;
    address chainlinkSequencerL1Sender = 0x37a0fcbf3e9f82c50fD589d9Ec3a7B98C045DfAe;
    address chainlinkPricefeedV1R1 = 0xa85233C63b9Ee964Add6F2cffe00Fd84eb32338f;
    address l1CrossDomainMessenger = 0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1;
    address l2CrossDomainMessenger = 0x4200000000000000000000000000000000000007;

    address contractAdmin = 0x76Ff908b6d43C182DAEC59b35CebC1d7A17D8086;

    address vETH = 0x8C835DFaA34e2AE61775e80EE29E2c724c6AE2BB;
    address weth = 0x4200000000000000000000000000000000000006;
    address usdc = 0x7F5c764cBc14f9669B88837ca1490cCa17c31607;
    IClearingHouse clearingHouse = IClearingHouse(0x82ac2CE43e33683c58BE4cDc40975E73aA50f459);
    IVault vault = IVault(0xAD7b4C162707E0B2b5f6fdDbD3f8538A5fbA0d60);
    CollateralManager collateralManager = CollateralManager(0x8Ac835C05530f10595C8015467339523154b4D85);

    uint160 constant offset = uint160(0x1111000000000000000000000000000000001111);
    uint256 constant maxUint = type(uint256).max;

    function setUp() public {
        alice = makeAddr("alice");
        deal(usdc, alice, 1000e6);
        deal(weth, alice, 5 ether);

        changePrank(alice);
        IERC20(usdc).approve(address(vault), maxUint);
        vault.deposit(address(usdc), 1000e6);
        IERC20(weth).approve(address(vault), maxUint);
        vault.deposit(address(weth), 5 ether);

        // change WETH price feed to newly deplyed ChainlinkPricefeedV1R1
        changePrank(contractAdmin);
        collateralManager.setPriceFeed(weth, chainlinkPricefeedV1R1);

        changePrank(alice);
        IClearingHouse.OpenPositionParams memory params =
            IClearingHouse.OpenPositionParams(vETH, false, true, 100 ether, 0, type(uint256).max, 0, 0x0);
        clearingHouse.openPosition(params);
    }

    function simulate_sequencer_status(bool status) private {
        bytes memory message =
            abi.encodeWithSelector(IOptimismSequencerUptimeFeed.updateStatus.selector, status, block.timestamp);
        address l2MessageSender = address(uint160(l1CrossDomainMessenger) + offset);
        changePrank(l2MessageSender);
        IL2CrossDomainMessenger(l2CrossDomainMessenger).relayMessage(
            optimismSequencerUptimeFeed,
            chainlinkSequencerL1Sender,
            message,
            10
        );
        changePrank(alice);
    }

    function test_getPrice_SequencerDown() public {
        // Verify the price feed is still available.
        uint256 price = IChainlinkPriceFeed(chainlinkPricefeedV1R1).getPrice(0);
        assertTrue(price != 0);

        // Simulate sequencer down message.
        simulate_sequencer_status(true);

        // Price feed should revert due to sequencer being down.
        vm.expectRevert("CPF_SD");
        IChainlinkPriceFeed(chainlinkPricefeedV1R1).getPrice(0);

        // Simulate sequencer up message.
        simulate_sequencer_status(false);

        // Price feed should still revert due to grace period not passed yet.
        vm.expectRevert("CPF_GPNO");
        IChainlinkPriceFeed(chainlinkPricefeedV1R1).getPrice(0);

        // Price feed should work due to grace period has passed.
        skip(3601); // Assume grace period = 3600 secs.
        assertTrue(IChainlinkPriceFeed(chainlinkPricefeedV1R1).getPrice(0) != 0);
    }

    function test_openPosition_SequencerDown() public {
        changePrank(alice);
        IClearingHouse.OpenPositionParams memory params =
            IClearingHouse.OpenPositionParams(vETH, false, true, 100 ether, 0, maxUint, 0, 0x0);
        clearingHouse.openPosition(params);

        // Simulate sequencer down message.
        simulate_sequencer_status(true);

        vm.expectRevert("CPF_SD");
        clearingHouse.openPosition(params);

        // Simulate sequencer up message.
        simulate_sequencer_status(false);

        // Price feed should still revert due to grace period not passed yet.
        vm.expectRevert("CPF_GPNO");
        clearingHouse.openPosition(params);

        // Price feed should work due to grace period has passed.
        skip(3601); // Assume grace period = 3600 secs.
        clearingHouse.openPosition(params);
    }

    function test_closePosition_SequencerDown() public {
        changePrank(alice);
        // Simulate sequencer down message.
        simulate_sequencer_status(true);
        IClearingHouse.ClosePositionParams memory params = IClearingHouse.ClosePositionParams(vETH, 0, 0, maxUint, 0x0);

        vm.expectRevert("CPF_SD");
        clearingHouse.closePosition(params);

        // Simulate sequencer up message.
        simulate_sequencer_status(false);

        // Price feed should still revert due to grace period not passed yet.
        vm.expectRevert("CPF_GPNO");
        clearingHouse.closePosition(params);

        // Price feed should work due to grace period has passed.
        skip(3601); // Assume grace period = 3600 secs.
        clearingHouse.closePosition(params);
    }

    function test_addLiquidity_SequencerDown() public {
        changePrank(alice);

        IClearingHouse.AddLiquidityParams memory params =
            IClearingHouse.AddLiquidityParams(vETH, 1 ether, 500 ether, 0, 150000, 0, 0, false, maxUint);
        clearingHouse.addLiquidity(params);

        // Simulate sequencer down message.
        simulate_sequencer_status(true);

        vm.expectRevert("CPF_SD");
        clearingHouse.addLiquidity(params);

        // Simulate sequencer up message.
        simulate_sequencer_status(false);

        // Price feed should still revert due to grace period not passed yet.
        vm.expectRevert("CPF_GPNO");
        clearingHouse.addLiquidity(params);

        // Price feed should work due to grace period has passed.
        skip(3601); // Assume grace period = 3600 secs.
        clearingHouse.addLiquidity(params);
    }

    function test_removeLiquidity_SequencerDown() public {
        changePrank(alice);

        IClearingHouse.AddLiquidityParams memory addLiquidityParams =
            IClearingHouse.AddLiquidityParams(vETH, 1 ether, 500 ether, 0, 150000, 0, 0, false, maxUint);
        clearingHouse.addLiquidity(addLiquidityParams);

        // Simulate sequencer down message.
        simulate_sequencer_status(true);

        IClearingHouse.RemoveLiquidityParams memory removeLiquidityParams =
            IClearingHouse.RemoveLiquidityParams(vETH, 0, 150000, 1, 0, 0, maxUint);
        clearingHouse.removeLiquidity(removeLiquidityParams);
    }
}
